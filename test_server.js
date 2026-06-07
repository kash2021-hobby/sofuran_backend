const express = require('express');
const { processPdf } = require('./utils/pdfProcessor');

const app = express();
app.get('/test', async (req, res) => {
  try {
    const result = await processPdf('valid.pdf');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(5001, () => console.log('Listening on 5001'));
