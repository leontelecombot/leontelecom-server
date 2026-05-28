const fs = require('fs');
const path = require('path');
const htmlToPdf = require('html-to-pdf');

const htmlPath = path.join(__dirname, 'REQUISITOS_PROYECTO.html');
const pdfPath = path.join(__dirname, 'REQUISITOS_PROYECTO_WHATSAPP.pdf');

if (!fs.existsSync(htmlPath)) {
  console.error('❌ Error: No se encontró REQUISITOS_PROYECTO.html');
  process.exit(1);
}

console.log('📄 Convirtiendo HTML a PDF...');

const options = {
  margin: 10,
  filename: pdfPath,
  image: { type: 'jpeg', quality: 0.98 },
  html2canvas: { scale: 2 },
  jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' }
};

htmlToPdf.convert(options)
  .then(pdf => {
    console.log('✅ PDF generado exitosamente!');
    console.log(`📁 Ubicación: ${pdfPath}`);
    console.log(`📊 Tamaño: ${(fs.statSync(pdfPath).size / 1024).toFixed(2)} KB`);
  })
  .catch(err => {
    console.error('❌ Error generando PDF:', err.message);
    process.exit(1);
  });
