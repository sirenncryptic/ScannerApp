const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Your Loyverse API settings (same as Google Apps Script)
const LOYVERSE_TOKEN = 'a45b05fd475f48a6be31a434a0905409';
const LOYVERSE_API_BASE = 'https://api.loyverse.com/v1.0';

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Serve your HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle barcode scanning (replaces your doPost function)
app.post('/scan', (req, res) => {
    const { barcode } = req.body;
    
    console.log('Scanning barcode:', barcode);
    
    // For now, return a test response
    res.json({
        success: true,
        product: "Test Product for " + barcode,
        barcode: barcode,
        counted: 1,
        currentStock: 5,
        difference: -4
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Scanner app running on port ${PORT}`);
});
