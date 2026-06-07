const fs = require('fs');
const { processPdf } = require('./utils/pdfProcessor');

async function run() {
  try {
    console.log('Testing processPdf with Feb_26.pdf...');
    const result = await processPdf('uploads/pdfs/1779196903327-Feb_26.pdf');
    console.log('Result title:', result.title);
    console.log('Result readTime:', result.readTime);
    console.log('Result heroImage:', result.heroImage);
    console.log('Result content length:', result.content.length);
  } catch (err) {
    console.error('Caught error:', err);
  }
}
run();
