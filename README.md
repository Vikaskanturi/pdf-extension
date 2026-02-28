# PDF Viewer Chrome Extension

A robust, feature-rich Chrome Extension that replaces the browser's default PDF viewer. Built natively with HTML, CSS, JavaScript, PDF.js, and pdf-lib, this extension allows you to view, annotate, and heavily edit your PDF documents directly in the browser—all while strictly adhering to Manifest V3 security guidelines.

## 🚀 Features

### Core Viewing
* **True Native Replacement**: Seamlessly intercepts `.pdf` URL navigations and redirects them into the interactive extension viewer.
* **Smart Zoom & Scroll Sync**: Provides flawless workspace scaling (`+` and `-` zoom) and real-time page scroll tracking using Intersection Observers.
* **Multiple Themes**: Supports full custom theming with Native Light, Dark Mode, and Night/Sepia reading modes.
* **Thumbnail Sidebar**: Automatically generated visual sidebar for quick page navigation.

### Advanced Editing & Annotation
* **Adobe-Style Text Highlighting**: Snap-to-text translucent highlighting based on native PDF text layer extraction. (Gracefully falls back to freehand highlighting on scanned documents).
* **Sketch & Eraser Tools**: Freehand drawing tools with customizable colors, stroke widths, and a dedicated canvas eraser.
* **Text & Image Overlays**: Inject editable text boxes and upload external images directly onto the document. Images support native drag-and-resize CSS handles.
* **Whiteout Redaction**: Drag and drop solid white rectangles to securely mask/redact classified information.
* **Full Page Assembly**: Tools to Insert Blank Pages, Add Pages to the end of the document, or Delete specific pages.

### Production-Grade History Engine
* **Global Undo & Redo (`Ctrl+Z` / `Ctrl+Y`)**: A comprehensive, global DOM-mutation action stack tracks everything. Whether you are drawing, moving images, editing text, creating redaction boxes, or deleting pages—everything can be instantly undone or redone.

### Zero Data Loss
* **Permanent Burn Save**: Compiles and permanently embeds all your canvas sketches, text annotations, images, redactions, and structural page changes directly into a brand new PDF utilizing `pdf-lib` for an accurate download.

---

## 🛠 Installation / Setup

This extension runs completely locally and relies on no external API calls after initial installation, ensuring maximum privacy for your documents.

### Prerequisites

Because Chrome Extension Manifest V3 strictly prohibits remotely hosted scripts (CDNs), you must download the core libraries into the extension folder before installation.

1. Clone or download this repository to your local machine:
   ```bash
   git clone https://github.com/Vikaskanturi/pdf-extension.git
   ```

2. Open PowerShell or your Terminal, navigate to the folder, and run the setup script. This script automatically downloads the exact correct versions of `pdf.js`, `pdf.worker.js`, and `pdf-lib.js` into a `/lib/` folder:
   ```powershell
   cd path/to/pdf-viewer-extension
   ./setup.ps1
   ```
   *(Note: If you are on Linux/Mac, you can manually download the 3 files listed inside `setup.ps1` and place them in a folder called `lib` within the root directory).*

### Loading into Chrome

1. Open Google Chrome.
2. In the URL bar, go to: `chrome://extensions/`
3. In the top right corner, toggle **Developer mode** to **ON**.
4. In the top left, click **Load unpacked**.
5. Select the `pdf-viewer-extension` folder.

That's it! Any PDF you open in Chrome will now route into this advanced viewer.

---

## 💻 Tech Stack

- **Extension Framework**: Chrome Manifest V3 (Service Workers, Declarative Net Requests)
- **Rendering**: PDF.js (Mozilla)
- **Document Manipulation**: pdf-lib
- **Frontend**: Vanilla HTML5, CSS3, ES6 JavaScript (No heavy frameworks, highly optimized).

---

## 📝 License

This project is open-source and available under the [MIT License](LICENSE).
