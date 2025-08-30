const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Your Loyverse API settings
const LOYVERSE_TOKEN = 'a45b05fd475f48a6be31a434a0905409';
const LOYVERSE_API_BASE = 'https://api.loyverse.com/v1.0';

// Store scan counts in memory
const scannedCounts = new Map();
const scannedItems = new Map();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Serve your HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle barcode scanning with proper counting
app.post('/scan', (req, res) => {
    const { barcode } = req.body;
    
    if (!barcode) {
        return res.json({ success: false, error: 'No barcode provided' });
    }
    
    console.log('Scanning barcode:', barcode);
    
    // Get current count for this barcode and increment
    const currentCount = scannedCounts.get(barcode) || 0;
    const newCount = currentCount + 1;
    
    // Store the new count
    scannedCounts.set(barcode, newCount);
    
    // Store item info
    const productName = `Test Product for ${barcode}`;
    scannedItems.set(barcode, {
        name: productName,
        count: newCount,
        lastScanned: new Date()
    });
    
    console.log(`${barcode} scanned ${newCount} times`);
    
    // Return response with incremented count
    res.json({
        success: true,
        product: productName,
        barcode: barcode,
        counted: newCount,
        currentStock: 5,
        difference: newCount - 5
    });
});

// Get all scanned items
app.get('/items', (req, res) => {
    const items = Array.from(scannedItems.entries()).map(([barcode, data]) => ({
        barcode,
        ...data
    }));
    res.json(items);
});

// Reset counts (for testing)
app.post('/reset', (req, res) => {
    scannedCounts.clear();
    scannedItems.clear();
    console.log('All counts reset');
    res.json({ success: true, message: 'All counts reset' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Scanner app running on port ${PORT}`);
    console.log('Count tracking active - each scan will increment by 1');
});
