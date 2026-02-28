# setup.ps1
# Script to download pdf.js and pdf.worker.js locally

$outDir = "lib"
New-Item -ItemType Directory -Force -Path $outDir

$pdfJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
$pdfWorkerUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
$pdfLibUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"

Write-Host "Downloading PDF.js..."
Invoke-WebRequest -Uri $pdfJsUrl -OutFile "$outDir\pdf.min.js"
Write-Host "Downloading PDF.worker.js..."
Invoke-WebRequest -Uri $pdfWorkerUrl -OutFile "$outDir\pdf.worker.min.js"
Write-Host "Downloading PDF-lib..."
Invoke-WebRequest -Uri $pdfLibUrl -OutFile "$outDir\pdf-lib.min.js"

Write-Host "Libraries downloaded successfully into '$outDir' folder."
