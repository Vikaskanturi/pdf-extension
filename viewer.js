// viewer.js

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Setup PDF.js
    if (typeof pdfjsLib === 'undefined') {
        alert("PDF.js library not loaded. Did you run setup.ps1 and include it in your extension?");
        return;
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

    // 2. Extract URL parameter (intercepted URL)
    const urlParams = new URLSearchParams(window.location.search);
    let originalPdfUrl = urlParams.get('url');

    // For testing purposes during development, if no URL is provided, load a dummy one (will fail if CORS restricts)
    if (!originalPdfUrl) {
        console.warn("No 'url' query parameter found. Waiting for user interaction or test file.");
        // We could provide a file input here, but since this is an extension, the URL should be passed.
    }

    // 3. UI Elements
    const pdfContainer = document.getElementById('pdf-container');
    const pageNumElem = document.getElementById('page-num');
    const pageCountElem = document.getElementById('page-count');
    const zoomInput = document.getElementById('zoom-input');

    let pdfDoc = null;
    let scale = 1.5;

    // Drawing & Tool state
    let currentTool = 'select'; // 'select', 'draw', 'text', 'img'
    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;

    // History & Synthetic Pages State
    let globalUndoStack = [];
    let globalRedoStack = [];

    function pushAction(action) {
        globalUndoStack.push(action);
        globalRedoStack = []; // Clear redo stack when new action occurs
    }

    let syntheticPages = 0;

    // Zoom & Scroll Tracking State
    let currentZoom = 1.0;
    const zoomInBtn = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');

    function updateZoomDisplay() {
        if (zoomInput) zoomInput.value = `${Math.round(currentZoom * 100)}%`;
        if (pdfContainer) {
            pdfContainer.style.zoom = currentZoom;
            pdfContainer.style.transform = 'none';
        }
    }

    if (zoomInBtn) zoomInBtn.addEventListener('click', () => { currentZoom += 0.25; updateZoomDisplay(); });
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => { currentZoom = Math.max(0.25, currentZoom - 0.25); updateZoomDisplay(); });

    const pageIntersections = new Map();
    const pageObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            pageIntersections.set(entry.target, entry.intersectionRatio);
        });

        let maxRatio = 0;
        let bestTarget = null;
        pageIntersections.forEach((ratio, target) => {
            if (ratio > maxRatio) {
                maxRatio = ratio;
                bestTarget = target;
            }
        });

        if (bestTarget && pageNumElem) {
            const wrappers = Array.from(document.querySelectorAll('.pdf-page-wrapper'));
            const idx = wrappers.indexOf(bestTarget);
            if (idx !== -1) {
                pageNumElem.textContent = idx + 1;
            }
        }
    }, {
        root: document.getElementById('viewer-container'),
        threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
    });

    // 4. Core Render Logic
    async function loadPdf(url) {
        try {
            // Fetch the PDF
            const loadingTask = pdfjsLib.getDocument(url);
            pdfDoc = await loadingTask.promise;

            pageCountElem.textContent = pdfDoc.numPages;

            // For a basic viewer, render all pages cleanly
            pdfContainer.innerHTML = ''; // Clear existing pages
            const thumbnailView = document.getElementById('thumbnail-view');
            if (thumbnailView) thumbnailView.innerHTML = '';
            globalUndoStack = [];
            globalRedoStack = [];
            syntheticPages = 0; // Reset synthetic pages count

            for (let i = 1; i <= pdfDoc.numPages; i++) {
                await renderPage(i);
            }
        } catch (err) {
            console.error("Error loading PDF:", err);
            // Fallback for CORS issues if accessing file:// or generic web URLs
            pdfContainer.innerHTML = `<p style="color:red">Failed to load PDF. Security/CORS exception or invalid URL.<br/>URL: ${url}</br>Details: ${err.message}</p>`;
        }
    }

    async function renderPage(num) {
        const page = await pdfDoc.getPage(num);
        const viewport = page.getViewport({ scale });

        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page-wrapper';
        wrapper.id = `page-wrapper-${num}`;
        wrapper.dataset.originalIndex = num - 1; // 0-indexed for copying later
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-render-canvas';
        const ctx = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const annoCanvas = document.createElement('canvas');
        annoCanvas.className = 'annotation-canvas';
        annoCanvas.id = `anno-canvas-${num}`;
        const annoCtx = annoCanvas.getContext('2d');
        annoCanvas.height = viewport.height;
        annoCanvas.width = viewport.width;
        annoCanvas.style.pointerEvents = currentTool === 'draw' ? 'auto' : 'none';

        let oldCanvasState = null;

        // Text Tool event listener
        wrapper.addEventListener('click', (e) => {
            if (currentTool !== 'text') return;
            const rect = wrapper.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const textColor = document.getElementById('text-color').value;
            const textDiv = document.createElement('div');
            textDiv.contentEditable = true;
            textDiv.className = 'overlay-element text-annotation selected';
            textDiv.style.left = `${x}px`;
            textDiv.style.top = `${y}px`;
            textDiv.style.color = textColor;
            textDiv.dataset.hexColor = textColor; // store exact hex for saving
            textDiv.innerText = 'New Text';

            // Allow dragging (simple implementation)
            let isDragging = false;
            let dragStartX, dragStartY;
            let initialLeft, initialTop;
            textDiv.addEventListener('mousedown', (dragEvent) => {
                if (currentTool !== 'select') return;
                isDragging = true;
                initialLeft = textDiv.style.left;
                initialTop = textDiv.style.top;
                dragStartX = dragEvent.clientX - textDiv.offsetLeft;
                dragStartY = dragEvent.clientY - textDiv.offsetTop;
                // Deselect others, select this
                document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
                textDiv.classList.add('selected');
                dragEvent.stopPropagation();
            });

            window.addEventListener('mousemove', (dragEvent) => {
                if (!isDragging) return;
                textDiv.style.left = `${dragEvent.clientX - dragStartX}px`;
                textDiv.style.top = `${dragEvent.clientY - dragStartY}px`;
            });
            window.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    const finalLeft = textDiv.style.left;
                    const finalTop = textDiv.style.top;
                    if (initialLeft !== finalLeft || initialTop !== finalTop) {
                        const node = textDiv;
                        const iL = initialLeft, iT = initialTop, fL = finalLeft, fT = finalTop;
                        pushAction({
                            type: 'MOVE_NODE',
                            undo: () => { node.style.left = iL; node.style.top = iT; },
                            redo: () => { node.style.left = fL; node.style.top = fT; }
                        });
                    }
                }
            });

            textDiv.addEventListener('click', (e) => {
                if (currentTool === 'select') {
                    document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
                    textDiv.classList.add('selected');
                    e.stopPropagation();
                }
            });

            // Edit text logic
            let initialText = '';
            textDiv.addEventListener('focus', () => initialText = textDiv.innerText);
            textDiv.addEventListener('blur', () => {
                const finalText = textDiv.innerText;
                if (initialText !== finalText) {
                    const node = textDiv;
                    const iText = initialText, fText = finalText;
                    pushAction({
                        type: 'EDIT_TEXT',
                        undo: () => node.innerText = iText,
                        redo: () => node.innerText = fText
                    });
                }
            });

            wrapper.appendChild(textDiv);
            textDiv.focus();

            const parentNode = wrapper;
            const nodeRef = textDiv;
            pushAction({
                type: 'ADD_TEXT',
                undo: () => nodeRef.remove(),
                redo: () => parentNode.appendChild(nodeRef)
            });

            // Automatically switch back to select tool
            updateTool('select');
        });

        // Click outside to deselect
        wrapper.addEventListener('click', () => {
            if (currentTool === 'select') {
                document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
            }
        });

        annoCanvas.addEventListener('mousedown', (e) => {
            if (currentTool !== 'draw' && currentTool !== 'erase' && currentTool !== 'highlight') return;
            isDrawing = true;
            oldCanvasState = annoCtx.getImageData(0, 0, annoCanvas.width, annoCanvas.height);
            const rect = annoCanvas.getBoundingClientRect();
            lastX = e.clientX - rect.left;
            lastY = e.clientY - rect.top;
        });

        annoCanvas.addEventListener('mousemove', (e) => {
            if (!isDrawing || (currentTool !== 'draw' && currentTool !== 'erase' && currentTool !== 'highlight')) return;
            const rect = annoCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            annoCtx.globalCompositeOperation = currentTool === 'erase' ? 'destination-out' : 'source-over';
            annoCtx.globalAlpha = currentTool === 'highlight' ? parseFloat(document.getElementById('highlight-opacity').value) : 1.0;

            annoCtx.beginPath();
            annoCtx.moveTo(lastX, lastY);
            annoCtx.lineTo(x, y);

            if (currentTool === 'erase') {
                annoCtx.strokeStyle = 'rgba(0,0,0,1)';
                annoCtx.lineWidth = parseInt(document.getElementById('eraser-width').value, 10);
            } else if (currentTool === 'highlight') {
                annoCtx.strokeStyle = document.getElementById('highlight-color').value;
                annoCtx.lineWidth = parseInt(document.getElementById('highlight-width').value, 10);
            } else {
                annoCtx.strokeStyle = document.getElementById('draw-color').value;
                annoCtx.lineWidth = parseInt(document.getElementById('draw-width').value, 10);
            }

            annoCtx.lineCap = 'round';
            annoCtx.stroke();
            annoCtx.globalAlpha = 1.0; // reset for next operations

            lastX = x;
            lastY = y;
        });

        annoCanvas.addEventListener('mouseup', () => {
            if (isDrawing) {
                isDrawing = false;
                const newState = annoCtx.getImageData(0, 0, annoCanvas.width, annoCanvas.height);
                const capturedOldState = oldCanvasState;
                pushAction({
                    type: 'DRAW',
                    undo: () => annoCtx.putImageData(capturedOldState, 0, 0),
                    redo: () => annoCtx.putImageData(newState, 0, 0)
                });
            }
        });
        annoCanvas.addEventListener('mouseout', () => {
            if (isDrawing) {
                isDrawing = false;
                const newState = annoCtx.getImageData(0, 0, annoCanvas.width, annoCanvas.height);
                const capturedOldState = oldCanvasState;
                pushAction({
                    type: 'DRAW',
                    undo: () => annoCtx.putImageData(capturedOldState, 0, 0),
                    redo: () => annoCtx.putImageData(newState, 0, 0)
                });
            }
        });

        wrapper.appendChild(canvas);
        wrapper.appendChild(annoCanvas);
        attachWhiteoutLogic(wrapper, annoCanvas);
        injectPageControls(wrapper);
        pdfContainer.appendChild(wrapper);
        pageObserver.observe(wrapper);

        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };
        await page.render(renderContext).promise;

        // Build Text Layer
        const textContent = await page.getTextContent();
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'text-layer';
        textLayerDiv.style.position = 'absolute';
        textLayerDiv.style.left = '0';
        textLayerDiv.style.top = '0';
        textLayerDiv.style.right = '0';
        textLayerDiv.style.bottom = '0';
        textLayerDiv.style.color = 'transparent';
        textLayerDiv.style.zIndex = '4';
        textLayerDiv.style.pointerEvents = 'none';
        if (currentTool === 'highlight' || currentTool === 'select') {
            textLayerDiv.classList.add('interactive');
        }

        textContent.items.forEach(item => {
            const span = document.createElement('span');
            span.textContent = item.str;
            span.style.position = 'absolute';
            span.style.transformOrigin = 'left bottom';
            span.style.whiteSpace = 'pre';
            span.style.cursor = 'text';

            if (item.transform) {
                const pt = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
                const fontSize = Math.abs(item.transform[3]) * viewport.scale;

                span.style.left = `${pt[0]}px`;
                span.style.top = `${pt[1] - fontSize}px`;
                span.style.fontSize = `${fontSize}px`;
                span.style.fontFamily = 'sans-serif';
                span.style.height = `${fontSize}px`;
            }
            textLayerDiv.appendChild(span);
        });
        wrapper.appendChild(textLayerDiv);

        // Add Thumbnail to Sidebar
        const thumbScale = 120 / viewport.width;
        const thumbViewport = page.getViewport({ scale: thumbScale });
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = thumbViewport.width;
        thumbCanvas.height = thumbViewport.height;
        thumbCanvas.className = 'thumbnail-canvas';
        const thumbCtx = thumbCanvas.getContext('2d');

        const thumbRenderContext = {
            canvasContext: thumbCtx,
            viewport: thumbViewport
        };
        await page.render(thumbRenderContext).promise;

        const thumbContainer = document.createElement('div');
        thumbContainer.className = 'thumbnail-container';
        thumbContainer.id = `thumb-page-wrapper-${num}`;
        thumbContainer.onclick = () => {
            wrapper.scrollIntoView({ behavior: 'smooth' });
        };
        const pageLabel = document.createElement('div');
        pageLabel.innerText = `${num}`;
        pageLabel.style.fontSize = '12px';
        pageLabel.style.textAlign = 'center';
        pageLabel.style.marginTop = '4px';

        thumbContainer.appendChild(thumbCanvas);
        thumbContainer.appendChild(pageLabel);

        const thumbnailView = document.getElementById('thumbnail-view');
        if (thumbnailView) thumbnailView.appendChild(thumbContainer);
    }

    if (originalPdfUrl) {
        loadPdf(originalPdfUrl);
    }

    // 5. Theming Logic
    const body = document.body;

    document.getElementById('btn-theme-light').addEventListener('click', () => {
        body.className = 'theme-light';
        chrome?.storage?.local?.set({ theme: 'theme-light' });
    });

    document.getElementById('btn-theme-dark').addEventListener('click', () => {
        body.className = 'theme-dark';
        chrome?.storage?.local?.set({ theme: 'theme-dark' });
    });

    document.getElementById('btn-theme-night').addEventListener('click', () => {
        body.className = 'theme-night';
        chrome?.storage?.local?.set({ theme: 'theme-night' });
    });

    // 6. Sidebar Toggle
    const sidebar = document.getElementById('sidebar');
    document.getElementById('toggle-sidebar').addEventListener('click', () => {
        sidebar.classList.toggle('hidden');
    });

    // 7. Load saved theme (if extension API is available)
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(['theme'], function (result) {
            if (result.theme) {
                body.className = result.theme;
            }
        });
    }

    const btnSelect = document.getElementById('btn-tool-select');
    const btnDraw = document.getElementById('btn-tool-draw');
    const btnHighlight = document.getElementById('btn-tool-highlight');
    const btnErase = document.getElementById('btn-tool-erase');
    const btnWhiteout = document.getElementById('btn-tool-whiteout');
    const btnText = document.getElementById('btn-tool-text');
    const btnImg = document.getElementById('btn-tool-img');
    const imgUpload = document.getElementById('img-upload');
    const btnAddPage = document.getElementById('btn-add-page');

    const settingsDraw = document.getElementById('settings-draw');
    const settingsHighlight = document.getElementById('settings-highlight');
    const settingsErase = document.getElementById('settings-erase');

    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    const btnSave = document.getElementById('btn-save');

    function updateTool(tool) {
        currentTool = tool;
        if (btnSelect) btnSelect.classList.toggle('active', tool === 'select');
        if (btnDraw) btnDraw.classList.toggle('active', tool === 'draw');
        if (btnHighlight) btnHighlight.classList.toggle('active', tool === 'highlight');
        if (btnErase) btnErase.classList.toggle('active', tool === 'erase');
        if (btnWhiteout) btnWhiteout.classList.toggle('active', tool === 'whiteout');
        if (btnText) btnText.classList.toggle('active', tool === 'text');

        if (settingsDraw) settingsDraw.style.display = tool === 'draw' ? 'flex' : 'none';
        if (settingsHighlight) settingsHighlight.style.display = tool === 'highlight' ? 'flex' : 'none';
        if (settingsErase) settingsErase.style.display = tool === 'erase' ? 'flex' : 'none';

        // Image tool acts as a one-off trigger, so don't leave it "active" in state
        if (tool === 'img') {
            imgUpload.click();
            updateTool('select');
            return;
        }

        // Update pointer events on all annotation canvases based on tool
        document.querySelectorAll('.annotation-canvas').forEach(canvas => {
            canvas.style.pointerEvents = (tool === 'draw' || tool === 'erase' || tool === 'highlight') ? 'auto' : 'none';
        });

        // Update pointer events for text layer tracking
        document.querySelectorAll('.text-layer').forEach(layer => {
            layer.classList.toggle('interactive', tool === 'highlight' || tool === 'select');
        });

        // Set wrapper cursors
        document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
            if (tool === 'text') wrapper.style.cursor = 'text';
            else if (tool === 'whiteout') wrapper.style.cursor = 'crosshair';
            else wrapper.style.cursor = 'default';
        });
    }

    if (btnSelect) btnSelect.addEventListener('click', () => updateTool('select'));
    if (btnDraw) btnDraw.addEventListener('click', () => updateTool('draw'));
    if (btnHighlight) btnHighlight.addEventListener('click', () => updateTool('highlight'));
    if (btnErase) btnErase.addEventListener('click', () => updateTool('erase'));
    if (btnWhiteout) btnWhiteout.addEventListener('click', () => updateTool('whiteout'));
    if (btnText) btnText.addEventListener('click', () => updateTool('text'));
    if (btnImg) btnImg.addEventListener('click', () => updateTool('img'));

    // Helper to find the most centered page wrapper
    function getVisiblePageWrapper() {
        const wrappers = Array.from(document.querySelectorAll('.pdf-page-wrapper'));
        const container = document.getElementById('viewer-container');
        if (wrappers.length === 0) return null;

        let closest = wrappers[0];
        let minDistance = Infinity;

        const containerCenter = container.getBoundingClientRect().top + (container.clientHeight / 2);

        wrappers.forEach(w => {
            const rect = w.getBoundingClientRect();
            const wCenter = rect.top + (rect.height / 2);
            const dist = Math.abs(containerCenter - wCenter);
            if (dist < minDistance) {
                minDistance = dist;
                closest = w;
            }
        });

        return closest;
    }

    // Image Upload Logic
    imgUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            // Find the active page wrapper in the center of the viewport
            let targetWrapper = getVisiblePageWrapper();
            if (!targetWrapper) return;

            const imgContainer = document.createElement('div');
            imgContainer.className = 'overlay-element img-container selected';
            imgContainer.style.left = '50px';
            imgContainer.style.top = '50px';
            imgContainer.style.width = '150px';
            imgContainer.style.height = '150px';
            imgContainer.style.resize = 'both';
            imgContainer.style.overflow = 'hidden';

            const img = document.createElement('img');
            img.className = 'img-annotation';
            img.src = event.target.result;
            // Store original type for saving
            img.dataset.mime = file.type;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.pointerEvents = 'none'; // so mousedown hits the container always

            imgContainer.appendChild(img);

            // Dragging & Resizing logic
            let isDragging = false;
            let isResizing = false;
            let dragStartX, dragStartY;
            let initialLeft, initialTop;
            let initialWidth, initialHeight;

            imgContainer.addEventListener('mousedown', (dragEvent) => {
                if (currentTool !== 'select') return;

                // Detect if clicking on the bottom-right native resize handle
                const rect = imgContainer.getBoundingClientRect();
                const overResizeHandle = (dragEvent.clientX > rect.right - 20 && dragEvent.clientY > rect.bottom - 20);

                if (overResizeHandle) {
                    isResizing = true;
                    initialWidth = imgContainer.style.width;
                    initialHeight = imgContainer.style.height;
                    return; // Let browser handle the resize natively
                }

                isDragging = true;
                initialLeft = imgContainer.style.left;
                initialTop = imgContainer.style.top;
                dragStartX = dragEvent.clientX - imgContainer.offsetLeft;
                dragStartY = dragEvent.clientY - imgContainer.offsetTop;

                document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
                imgContainer.classList.add('selected');
                dragEvent.stopPropagation();
            });

            window.addEventListener('mousemove', (dragEvent) => {
                if (!isDragging) return;
                imgContainer.style.left = `${dragEvent.clientX - dragStartX}px`;
                imgContainer.style.top = `${dragEvent.clientY - dragStartY}px`;
            });

            window.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    const finalLeft = imgContainer.style.left;
                    const finalTop = imgContainer.style.top;
                    if (initialLeft !== finalLeft || initialTop !== finalTop) {
                        const node = imgContainer;
                        const iL = initialLeft, iT = initialTop, fL = finalLeft, fT = finalTop;
                        pushAction({
                            type: 'MOVE_NODE',
                            undo: () => { node.style.left = iL; node.style.top = iT; },
                            redo: () => { node.style.left = fL; node.style.top = fT; }
                        });
                    }
                }

                if (isResizing) {
                    isResizing = false;
                    const finalWidth = imgContainer.style.width || `${imgContainer.offsetWidth}px`;
                    const finalHeight = imgContainer.style.height || `${imgContainer.offsetHeight}px`;
                    if (initialWidth !== finalWidth || initialHeight !== finalHeight) {
                        const node = imgContainer;
                        const iW = initialWidth, iH = initialHeight, fW = finalWidth, fH = finalHeight;
                        pushAction({
                            type: 'RESIZE_NODE',
                            undo: () => { node.style.width = iW; node.style.height = iH; },
                            redo: () => { node.style.width = fW; node.style.height = fH; }
                        });
                    }
                }
            });

            targetWrapper.appendChild(imgContainer);

            const parentNode = targetWrapper;
            const nodeRef = imgContainer;
            pushAction({
                type: 'ADD_IMG',
                undo: () => nodeRef.remove(),
                redo: () => parentNode.appendChild(nodeRef)
            });

            // Reset input
            imgUpload.value = '';
        };
        reader.readAsDataURL(file);
    });

    let synthPageIdCounter = 10000;
    function createSyntheticPageWrapper(defaultWidth, defaultHeight) {
        synthPageIdCounter++;
        const id = synthPageIdCounter;

        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page-wrapper synthetic-page';
        wrapper.id = `page-wrapper-${id}`;
        wrapper.style.width = `${defaultWidth}px`;
        wrapper.style.height = `${defaultHeight}px`;
        // Synthetic pages leave backgroundColor empty to inherit CSS variables from viewer.css
        wrapper.style.backgroundColor = '';

        const annoCanvas = document.createElement('canvas');
        annoCanvas.className = 'annotation-canvas';
        annoCanvas.id = `anno-canvas-${id}`;
        const annoCtx = annoCanvas.getContext('2d');
        annoCanvas.height = defaultHeight;
        annoCanvas.width = defaultWidth;
        annoCanvas.style.pointerEvents = currentTool === 'draw' || currentTool === 'erase' ? 'auto' : 'none';

        let localIsDrawing = false;
        let localLastX = 0, localLastY = 0;
        let oldCanvasState = null;

        annoCanvas.addEventListener('mousedown', (e) => {
            if (currentTool !== 'draw' && currentTool !== 'erase' && currentTool !== 'highlight') return;
            localIsDrawing = true;
            oldCanvasState = annoCtx.getImageData(0, 0, annoCanvas.width, annoCanvas.height);
            const rect = annoCanvas.getBoundingClientRect();
            localLastX = e.clientX - rect.left;
            localLastY = e.clientY - rect.top;
        });

        annoCanvas.addEventListener('mousemove', (e) => {
            if (!localIsDrawing || (currentTool !== 'draw' && currentTool !== 'erase' && currentTool !== 'highlight')) return;
            const rect = annoCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            annoCtx.globalCompositeOperation = currentTool === 'erase' ? 'destination-out' : 'source-over';
            annoCtx.globalAlpha = currentTool === 'highlight' ? 0.2 : 1.0;

            annoCtx.beginPath();
            annoCtx.moveTo(localLastX, localLastY);
            annoCtx.lineTo(x, y);

            if (currentTool === 'erase') {
                annoCtx.strokeStyle = 'rgba(0,0,0,1)';
                annoCtx.lineWidth = parseInt(document.getElementById('eraser-width').value, 10);
            } else if (currentTool === 'highlight') {
                annoCtx.strokeStyle = document.getElementById('highlight-color').value;
                annoCtx.lineWidth = parseInt(document.getElementById('highlight-width').value, 10);
            } else {
                annoCtx.strokeStyle = document.getElementById('draw-color').value;
                annoCtx.lineWidth = parseInt(document.getElementById('draw-width').value, 10);
            }

            annoCtx.lineCap = 'round';
            annoCtx.stroke();
            annoCtx.globalAlpha = 1.0; // reset

            localLastX = x;
            localLastY = y;
        });

        annoCanvas.addEventListener('mouseup', () => {
            if (localIsDrawing) {
                localIsDrawing = false;
                const newState = annoCtx.getImageData(0, 0, annoCanvas.width, annoCanvas.height);
                const capturedOldState = oldCanvasState;
                pushAction({
                    type: 'DRAW',
                    undo: () => annoCtx.putImageData(capturedOldState, 0, 0),
                    redo: () => annoCtx.putImageData(newState, 0, 0)
                });
            }
        });
        annoCanvas.addEventListener('mouseout', () => {
            if (localIsDrawing) {
                localIsDrawing = false;
                const newState = annoCtx.getImageData(0, 0, annoCanvas.width, annoCanvas.height);
                const capturedOldState = oldCanvasState;
                pushAction({
                    type: 'DRAW',
                    undo: () => annoCtx.putImageData(capturedOldState, 0, 0),
                    redo: () => annoCtx.putImageData(newState, 0, 0)
                });
            }
        });

        wrapper.addEventListener('click', (e) => {
            if (currentTool !== 'text') return;
            const textColor = document.getElementById('text-color').value;
            const rect = wrapper.getBoundingClientRect();
            const textDiv = document.createElement('div');
            textDiv.contentEditable = true;
            textDiv.className = 'overlay-element text-annotation selected';
            textDiv.style.left = `${e.clientX - rect.left}px`;
            textDiv.style.top = `${e.clientY - rect.top}px`;
            textDiv.style.color = textColor;
            textDiv.dataset.hexColor = textColor;
            textDiv.innerText = 'New Text';

            let isDragging = false;
            let dragX, dragY;
            textDiv.addEventListener('mousedown', (ev) => {
                if (currentTool !== 'select') return;
                isDragging = true;
                dragX = ev.clientX - textDiv.offsetLeft;
                dragY = ev.clientY - textDiv.offsetTop;
                document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
                textDiv.classList.add('selected');
                ev.stopPropagation();
            });
            window.addEventListener('mousemove', (ev) => {
                if (!isDragging) return;
                textDiv.style.left = `${ev.clientX - dragX}px`;
                textDiv.style.top = `${ev.clientY - dragY}px`;
            });
            window.addEventListener('mouseup', () => isDragging = false);
            textDiv.addEventListener('click', (ev) => {
                if (currentTool === 'select') {
                    document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
                    textDiv.classList.add('selected');
                    ev.stopPropagation();
                }
            });
            wrapper.appendChild(textDiv);
            textDiv.focus();
            updateTool('select');
        });

        wrapper.addEventListener('click', () => {
            if (currentTool === 'select') {
                document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
            }
        });

        wrapper.appendChild(annoCanvas);
        attachWhiteoutLogic(wrapper, annoCanvas);
        injectPageControls(wrapper);
        return wrapper;
    }

    function attachWhiteoutLogic(wrapper, annoCanvas) {
        let activeWhiteout = null;
        let whiteoutStartX = 0, whiteoutStartY = 0;

        wrapper.addEventListener('mousedown', (e) => {
            if (currentTool !== 'whiteout') return;
            const rect = wrapper.getBoundingClientRect();
            whiteoutStartX = e.clientX - rect.left;
            whiteoutStartY = e.clientY - rect.top;

            activeWhiteout = document.createElement('div');
            activeWhiteout.className = 'overlay-element whiteout-box selected';
            activeWhiteout.style.left = `${whiteoutStartX}px`;
            activeWhiteout.style.top = `${whiteoutStartY}px`;
            activeWhiteout.style.width = `0px`;
            activeWhiteout.style.height = `0px`;
            wrapper.appendChild(activeWhiteout);

            document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
            activeWhiteout.classList.add('selected');
        });

        wrapper.addEventListener('mousemove', (e) => {
            if (currentTool !== 'whiteout' || !activeWhiteout) return;
            const rect = wrapper.getBoundingClientRect();
            const currentX = e.clientX - rect.left;
            const currentY = e.clientY - rect.top;

            const width = Math.abs(currentX - whiteoutStartX);
            const height = Math.abs(currentY - whiteoutStartY);

            activeWhiteout.style.width = `${width}px`;
            activeWhiteout.style.height = `${height}px`;
            activeWhiteout.style.left = `${Math.min(currentX, whiteoutStartX)}px`;
            activeWhiteout.style.top = `${Math.min(currentY, whiteoutStartY)}px`;
        });

        wrapper.addEventListener('mouseup', () => {
            if (activeWhiteout) {
                if (parseInt(activeWhiteout.style.width) < 5 || parseInt(activeWhiteout.style.height) < 5) {
                    activeWhiteout.remove();
                } else {
                    const parentNode = wrapper;
                    const nodeRef = activeWhiteout;
                    pushAction({
                        type: 'ADD_WHITEOUT',
                        undo: () => nodeRef.remove(),
                        redo: () => parentNode.appendChild(nodeRef)
                    });

                    let isDraggingBox = false;
                    let dragX, dragY;
                    let initialLeft, initialTop;
                    const box = activeWhiteout;
                    box.addEventListener('mousedown', (ev) => {
                        if (currentTool !== 'select') return;
                        isDraggingBox = true;
                        initialLeft = box.style.left;
                        initialTop = box.style.top;
                        dragX = ev.clientX - box.offsetLeft;
                        dragY = ev.clientY - box.offsetTop;
                        document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
                        box.classList.add('selected');
                        ev.stopPropagation();
                    });
                    window.addEventListener('mousemove', (ev) => {
                        if (!isDraggingBox) return;
                        box.style.left = `${ev.clientX - dragX}px`;
                        box.style.top = `${ev.clientY - dragY}px`;
                    });
                    window.addEventListener('mouseup', () => {
                        if (isDraggingBox) {
                            isDraggingBox = false;
                            const finalLeft = box.style.left;
                            const finalTop = box.style.top;
                            if (initialLeft !== finalLeft || initialTop !== finalTop) {
                                const node = box;
                                const iL = initialLeft, iT = initialTop, fL = finalLeft, fT = finalTop;
                                pushAction({
                                    type: 'MOVE_NODE',
                                    undo: () => { node.style.left = iL; node.style.top = iT; },
                                    redo: () => { node.style.left = fL; node.style.top = fT; }
                                });
                            }
                        }
                    });
                    box.addEventListener('click', (ev) => {
                        if (currentTool === 'select') {
                            document.querySelectorAll('.overlay-element').forEach(el => el.classList.remove('selected'));
                            box.classList.add('selected');
                            ev.stopPropagation();
                        }
                    });
                }
                activeWhiteout = null;
            }
        });
    }

    function updateThumbnailsAndCount() {
        const wrappers = Array.from(document.querySelectorAll('.pdf-page-wrapper'));
        const pageCountElem = document.getElementById('page-count');
        if (pageCountElem) pageCountElem.textContent = wrappers.length;

        const thumbnailView = document.getElementById('thumbnail-view');
        if (!thumbnailView) return;

        wrappers.forEach((wrapper, index) => {
            const wrapperId = wrapper.id || `wrapper-orig-${index}`;
            if (!wrapper.id) wrapper.id = wrapperId;
            const thumbId = `thumb-${wrapperId}`;

            let thumbContainer = document.getElementById(thumbId);
            if (!thumbContainer) {
                thumbContainer = document.createElement('div');
                thumbContainer.className = 'thumbnail-container synthetic-thumbnail';
                thumbContainer.id = thumbId;
                thumbContainer.onclick = () => {
                    wrapper.scrollIntoView({ behavior: 'smooth' });
                };

                const thumbWidth = 120;
                let originalWidth = parseInt(wrapper.style.width) || 600;
                let originalHeight = parseInt(wrapper.style.height) || 800;
                const thumbScale = thumbWidth / originalWidth;
                const thumbHeight = originalHeight * thumbScale;

                const thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = thumbWidth;
                thumbCanvas.height = thumbHeight;
                thumbCanvas.className = 'thumbnail-canvas';
                const thumbCtx = thumbCanvas.getContext('2d');
                thumbCtx.fillStyle = '#ffffff';
                thumbCtx.fillRect(0, 0, thumbWidth, thumbHeight);

                const pageLabel = document.createElement('div');
                pageLabel.className = 'thumbnail-label';
                pageLabel.innerText = `${index + 1}`;
                pageLabel.style.fontSize = '12px';
                pageLabel.style.textAlign = 'center';
                pageLabel.style.marginTop = '4px';

                thumbContainer.appendChild(thumbCanvas);
                thumbContainer.appendChild(pageLabel);

                if (index < thumbnailView.children.length) {
                    thumbnailView.insertBefore(thumbContainer, thumbnailView.children[index]);
                } else {
                    thumbnailView.appendChild(thumbContainer);
                }
            } else {
                if (thumbnailView.children[index] !== thumbContainer) {
                    thumbnailView.insertBefore(thumbContainer, thumbnailView.children[index]);
                }
                const label = thumbContainer.querySelector('.thumbnail-label') || thumbContainer.querySelector('div:last-child');
                if (label) label.innerText = `${index + 1}`;
            }
        });

        const validThumbIds = new Set(wrappers.map(w => `thumb-${w.id}`));
        Array.from(thumbnailView.children).forEach(child => {
            if (child.id && !validThumbIds.has(child.id)) {
                child.remove();
            }
        });
    }

    function injectPageControls(wrapper) {
        const controls = document.createElement('div');
        controls.className = 'page-controls';

        const btnInsert = document.createElement('button');
        btnInsert.innerHTML = '📄+';
        btnInsert.title = 'Insert Blank Page Below';
        btnInsert.onclick = () => {
            const defaultWidth = parseInt(wrapper.style.width) || 600;
            const defaultHeight = parseInt(wrapper.style.height) || 800;
            const newWrapper = createSyntheticPageWrapper(defaultWidth, defaultHeight);

            const parent = wrapper.parentNode;
            const nextSibling = wrapper.nextSibling;
            parent.insertBefore(newWrapper, nextSibling);
            pageObserver.observe(newWrapper);

            pushAction({
                type: 'INSERT_PAGE',
                undo: () => { newWrapper.remove(); updateThumbnailsAndCount(); },
                redo: () => { parent.insertBefore(newWrapper, nextSibling); updateThumbnailsAndCount(); }
            });
            updateThumbnailsAndCount();
        };

        const btnDel = document.createElement('button');
        btnDel.innerHTML = '🗑️';
        btnDel.title = 'Delete Page';
        btnDel.onclick = () => {
            const parent = wrapper.parentNode;
            const nextSibling = wrapper.nextSibling;
            wrapper.remove();

            pushAction({
                type: 'REMOVE_PAGE',
                undo: () => { parent.insertBefore(wrapper, nextSibling); updateThumbnailsAndCount(); },
                redo: () => { wrapper.remove(); updateThumbnailsAndCount(); }
            });
            updateThumbnailsAndCount();
        };

        controls.appendChild(btnInsert);
        controls.appendChild(btnDel);
        wrapper.appendChild(controls);
    }

    // Add Blank Page Logic
    if (btnAddPage) btnAddPage.addEventListener('click', () => {
        if (!pdfDoc) return; // Need a loaded PDF as base

        // Base the size on page 1 viewport if available
        let defaultWidth = 600;
        let defaultHeight = 800;
        const page1wrapper = document.querySelector('.pdf-page-wrapper');
        if (page1wrapper) {
            defaultWidth = parseInt(page1wrapper.style.width) || 600;
            defaultHeight = parseInt(page1wrapper.style.height) || 800;
        }

        const newWrapper = createSyntheticPageWrapper(defaultWidth, defaultHeight);
        const container = document.getElementById('pdf-container');
        container.appendChild(newWrapper);
        pageObserver.observe(newWrapper);

        pushAction({
            type: 'ADD_PAGE_END',
            undo: () => { newWrapper.remove(); updateThumbnailsAndCount(); },
            redo: () => { container.appendChild(newWrapper); updateThumbnailsAndCount(); }
        });
        updateThumbnailsAndCount();
    });

    // Undo / Redo Functions
    function performUndo() {
        if (globalUndoStack.length === 0) return;
        const action = globalUndoStack.pop();
        action.undo();
        globalRedoStack.push(action);
    }

    function performRedo() {
        if (globalRedoStack.length === 0) return;
        const action = globalRedoStack.pop();
        action.redo();
        globalUndoStack.push(action);
    }

    if (btnUndo) btnUndo.addEventListener('click', performUndo);
    if (btnRedo) btnRedo.addEventListener('click', performRedo);

    // Keyboard bindings for undo/redo
    window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            performUndo();
        } else if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            performRedo();
        }
    });

    // Native text selection for highlight tool
    document.addEventListener('mouseup', () => {
        if (currentTool === 'highlight') {
            const selection = window.getSelection();
            if (!selection.isCollapsed) {
                const range = selection.getRangeAt(0);
                const rects = range.getClientRects();
                if (rects.length === 0) return;

                const node = range.commonAncestorContainer;
                const element = node.nodeType === 3 ? node.parentElement : node;
                const wrapper = element ? element.closest('.pdf-page-wrapper') : null;
                if (!wrapper) return;

                const wrapperRect = wrapper.getBoundingClientRect();
                const highlightColor = document.getElementById('highlight-color').value;
                const highlightOpacity = document.getElementById('highlight-opacity').value;

                const boxGroup = document.createElement('div');
                boxGroup.className = 'highlight-group overlay-element';
                boxGroup.style.position = 'absolute';
                boxGroup.style.left = '0';
                boxGroup.style.top = '0';
                boxGroup.style.width = '100%';
                boxGroup.style.height = '100%';
                boxGroup.style.pointerEvents = 'none'; // click through
                boxGroup.style.zIndex = '3'; // under text layer

                for (let i = 0; i < rects.length; i++) {
                    const rect = rects[i];
                    const hlBox = document.createElement('div');
                    hlBox.className = 'highlight-text-box';

                    const x = (rect.left - wrapperRect.left) / currentZoom;
                    const y = (rect.top - wrapperRect.top) / currentZoom - 2; // slight padding adjustment
                    const w = rect.width / currentZoom;
                    const h = rect.height / currentZoom + 4;

                    hlBox.style.left = `${x}px`;
                    hlBox.style.top = `${y}px`;
                    hlBox.style.width = `${w}px`;
                    hlBox.style.height = `${h}px`;
                    hlBox.style.backgroundColor = highlightColor;
                    hlBox.style.opacity = highlightOpacity;
                    hlBox.style.position = 'absolute';
                    hlBox.style.mixBlendMode = 'multiply';
                    boxGroup.appendChild(hlBox);
                }

                wrapper.appendChild(boxGroup);

                const ref = boxGroup;
                const parentNode = wrapper;
                pushAction({
                    type: 'ADD_TEXT_HIGHLIGHT',
                    undo: () => ref.remove(),
                    redo: () => parentNode.appendChild(ref)
                });

                selection.removeAllRanges();
            }
        }
    });

    // Helper to extract hex to r,g,b in [0..1] range for pdf-lib
    function hexToRgbArr(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255
        ] : [0, 0, 0];
    }

    if (btnSave) btnSave.addEventListener('click', async () => {
        if (!pdfDoc) return;
        const originalText = btnSave.textContent;
        btnSave.textContent = "Saving...";
        try {
            const pdfBytes = await pdfDoc.getData();
            const originalLibDoc = await PDFLib.PDFDocument.load(pdfBytes);
            const finalDoc = await PDFLib.PDFDocument.create();
            const helveticaFont = await finalDoc.embedFont(PDFLib.StandardFonts.Helvetica);

            const wrappers = Array.from(document.getElementById('pdf-container').children);

            // Construct new document dynamically from DOM order
            for (let wrapper of wrappers) {
                let page;
                if (wrapper.classList.contains('synthetic-page')) {
                    const w = parseInt(wrapper.style.width) || 600;
                    const h = parseInt(wrapper.style.height) || 800;
                    page = finalDoc.addPage([w, h]);
                } else {
                    const originalIndex = parseInt(wrapper.dataset.originalIndex);
                    if (!isNaN(originalIndex)) {
                        const [copiedPage] = await finalDoc.copyPages(originalLibDoc, [originalIndex]);
                        page = finalDoc.addPage(copiedPage);
                    } else {
                        continue;
                    }
                }

                // 1. Process Canvas Annotations (Sketching/Eraser strokes)
                const annoCanvas = wrapper.querySelector('.annotation-canvas');
                if (annoCanvas) {
                    const ctx = annoCanvas.getContext('2d');
                    const pixelBuffer = new Uint32Array(ctx.getImageData(0, 0, annoCanvas.width, annoCanvas.height).data.buffer);
                    const hasDrawing = pixelBuffer.some(color => color !== 0);

                    if (hasDrawing) {
                        const pngDataUrl = annoCanvas.toDataURL('image/png');
                        const pngImage = await finalDoc.embedPng(pngDataUrl);
                        page.drawImage(pngImage, {
                            x: 0,
                            y: 0,
                            width: page.getWidth(),
                            height: page.getHeight()
                        });
                    }
                }

                // 2. Process Whiteout Boxes
                const whiteoutElements = wrapper.querySelectorAll('.whiteout-box');
                whiteoutElements.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    const wrapperRect = wrapper.getBoundingClientRect();

                    const x = rect.left - wrapperRect.left;
                    const yHTML = rect.top - wrapperRect.top;
                    const yPDF = page.getHeight() - yHTML - rect.height;

                    page.drawRectangle({
                        x: x,
                        y: yPDF,
                        width: rect.width,
                        height: rect.height,
                        color: PDFLib.rgb(1, 1, 1),
                        borderWidth: 0
                    });
                });

                // 3. Process Text Overlays
                const textElements = wrapper.querySelectorAll('.text-annotation');
                textElements.forEach(el => {
                    const text = el.innerText;
                    if (!text.trim()) return;

                    const x = parseFloat(el.style.left) || 0;
                    const yHTML = parseFloat(el.style.top) || 0;
                    const yPDF = page.getHeight() - yHTML - 16;

                    const hexColor = el.dataset.hexColor || '#000000';
                    const [r, g, b] = hexToRgbArr(hexColor);

                    page.drawText(text, {
                        x: x,
                        y: yPDF,
                        size: 16,
                        font: helveticaFont,
                        color: PDFLib.rgb(r, g, b),
                    });
                });

                // 4. Process Image Overlays
                const imgContainers = wrapper.querySelectorAll('.img-container');
                for (let container of imgContainers) {
                    const imgEl = container.querySelector('img');
                    if (!imgEl || !imgEl.src) continue;

                    const mime = imgEl.dataset.mime || 'image/png';
                    const srcStr = imgEl.src;

                    let embeddedImg;
                    if (mime === 'image/jpeg' || mime === 'image/jpg') {
                        embeddedImg = await finalDoc.embedJpg(srcStr);
                    } else {
                        embeddedImg = await finalDoc.embedPng(srcStr);
                    }

                    const rect = imgEl.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    const wrapperRect = wrapper.getBoundingClientRect();

                    const x = containerRect.left - wrapperRect.left;
                    const yHTML = containerRect.top - wrapperRect.top;
                    const yPDF = page.getHeight() - yHTML - rect.height;

                    page.drawImage(embeddedImg, {
                        x: x,
                        y: yPDF,
                        width: rect.width,
                        height: rect.height
                    });
                }

                // 5. Process Text Highlights
                const highlightGroups = wrapper.querySelectorAll('.highlight-group');
                highlightGroups.forEach(group => {
                    const boxes = group.querySelectorAll('.highlight-text-box');
                    boxes.forEach(el => {
                        const x = parseFloat(el.style.left);
                        const yHTML = parseFloat(el.style.top);
                        const width = parseFloat(el.style.width);
                        const height = parseFloat(el.style.height);
                        const yPDF = page.getHeight() - yHTML - height;

                        const rgbString = el.style.backgroundColor;
                        const rgbMatch = rgbString.match(/\d+/g);
                        const r = rgbMatch ? parseInt(rgbMatch[0]) / 255 : 1;
                        const g = rgbMatch ? parseInt(rgbMatch[1]) / 255 : 1;
                        const b = rgbMatch ? parseInt(rgbMatch[2]) / 255 : 0;

                        const opacity = parseFloat(el.style.opacity) || 0.2;

                        page.drawRectangle({
                            x: x,
                            y: yPDF,
                            width: width,
                            height: height,
                            color: PDFLib.rgb(r, g, b),
                            opacity: opacity,
                            borderWidth: 0
                        });
                    });
                });
            }

            const modifiedPdfBytes = await finalDoc.save();
            const blob = new Blob([modifiedPdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'annotated.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Save error:", err);
            alert("Error saving PDF.");
        } finally {
            btnSave.textContent = originalText;
        }
    });

});
