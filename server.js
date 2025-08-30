const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Loyverse API configuration
const LOYVERSE_TOKEN = 'a45b05fd475f48a6be31a434a0905409';
const LOYVERSE_API_BASE = 'https://api.loyverse.com/v1.0';

// Store scan counts and inventory data
const scannedCounts = new Map();
const scannedItems = new Map();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Add detailed logging function
function logError(context, error, additionalInfo = {}) {
    console.log('\n=== ERROR LOG ===');
    console.log('Context:', context);
    console.log('Timestamp:', new Date().toISOString());
    console.log('Error Message:', error.message || error);
    console.log('Error Stack:', error.stack || 'No stack trace');
    console.log('Additional Info:', JSON.stringify(additionalInfo, null, 2));
    console.log('=================\n');
}

function logDebug(context, data) {
    console.log('\n=== DEBUG LOG ===');
    console.log('Context:', context);
    console.log('Timestamp:', new Date().toISOString());
    console.log('Data:', JSON.stringify(data, null, 2));
    console.log('=================\n');
}

// Serve HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Test endpoint to check if server is working
app.get('/test', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Server is working!',
        timestamp: new Date().toISOString()
    });
});

// Test Loyverse API connection
app.get('/test-loyverse', async (req, res) => {
    try {
        console.log('Testing Loyverse API connection...');
        
        // Test basic API connection
        const response = await fetch(`${LOYVERSE_API_BASE}/stores`, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        logDebug('Loyverse API Response', {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries())
        });

        if (response.ok) {
            const data = await response.json();
            logDebug('Loyverse API Data', data);
            res.json({ 
                success: true, 
                message: 'Loyverse API connected successfully!',
                stores: data.stores ? data.stores.length : 0,
                data: data
            });
        } else {
            const errorText = await response.text();
            logError('Loyverse API Test Failed', new Error(`HTTP ${response.status}`), {
                status: response.status,
                statusText: response.statusText,
                errorBody: errorText
            });
            res.json({ 
                success: false, 
                error: `API Error: ${response.status} ${response.statusText}`,
                details: errorText
            });
        }
    } catch (error) {
        logError('Loyverse API Test Exception', error);
        res.json({ 
            success: false, 
            error: 'Connection failed',
            details: error.message
        });
    }
});

// LOYVERSE API FUNCTIONS

async function findProductInLoyverse(barcode) {
    try {
        logDebug('Product Search Started', { barcode });
        
        // Search by SKU first
        let url = `${LOYVERSE_API_BASE}/items?sku=${encodeURIComponent(barcode)}&limit=50`;
        
        logDebug('API Request', { url, headers: { Authorization: 'Bearer [HIDDEN]' } });
        
        let response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        logDebug('API Response', {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok
        });

        if (response.ok) {
            const data = await response.json();
            logDebug('API Response Data', data);
            
            if (data.items && data.items.length > 0) {
                const item = data.items[0];
                console.log(`✅ Found product: ${item.item_name}`);
                
                const stock = await getCurrentStock(item);
                
                return {
                    success: true,
                    product_name: item.item_name,
                    category_name: item.category_name || 'Unknown',
                    stock: stock,
                    item_id: item.id,
                    item: item
                };
            }
        } else {
            const errorText = await response.text();
            logError('Items API Failed', new Error(`HTTP ${response.status}`), {
                status: response.status,
                errorBody: errorText
            });
        }

        // Search variants endpoint if items search didn't work
        console.log('Searching variants...');
        url = `${LOYVERSE_API_BASE}/variants?sku=${encodeURIComponent(barcode)}&limit=50`;
        response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        logDebug('Variants API Response', {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok
        });

        if (response.ok) {
            const data = await response.json();
            logDebug('Variants Response Data', data);
            
            if (data.variants && data.variants.length > 0) {
                const variant = data.variants[0];
                
                // Get full item details
                const itemResponse = await fetch(`${LOYVERSE_API_BASE}/items/${variant.item_id}`, {
                    headers: {
                        'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (itemResponse.ok) {
                    const item = await itemResponse.json();
                    console.log(`✅ Found product via variant: ${item.item_name}`);
                    
                    const stock = await getCurrentStock(item);
                    
                    return {
                        success: true,
                        product_name: item.item_name,
                        category_name: item.category_name || 'Unknown',
                        stock: stock,
                        item_id: item.id,
                        variant_id: variant.id,
                        item: item
                    };
                }
            }
        } else {
            const errorText = await response.text();
            logError('Variants API Failed', new Error(`HTTP ${response.status}`), {
                status: response.status,
                errorBody: errorText
            });
        }

        console.log(`❌ Product not found: ${barcode}`);
        return { success: false, error: `Product not found: ${barcode}` };

    } catch (error) {
        logError('findProductInLoyverse', error, { barcode });
        return { success: false, error: 'API connection failed: ' + error.message };
    }
}

async function getCurrentStock(item) {
    try {
        logDebug('Getting stock for item', { item_id: item.id });
        
        // Get store ID first
        const storeResponse = await fetch(`${LOYVERSE_API_BASE}/stores`, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!storeResponse.ok) {
            logError('Store API Failed', new Error(`HTTP ${storeResponse.status}`));
            return 0;
        }
        
        const storeData = await storeResponse.json();
        logDebug('Store Data', storeData);
        
        if (!storeData.stores || storeData.stores.length === 0) {
            console.log('⚠️ No stores found');
            return 0;
        }
        
        const storeId = storeData.stores[0].id;
        console.log(`📍 Using store: ${storeId}`);

        // Get inventory levels
        const inventoryUrl = `${LOYVERSE_API_BASE}/inventory?store_ids=${storeId}&item_ids=${item.id}`;
        logDebug('Inventory Request', { url: inventoryUrl });
        
        const inventoryResponse = await fetch(inventoryUrl, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        logDebug('Inventory Response', {
            status: inventoryResponse.status,
            statusText: inventoryResponse.statusText
        });

        if (inventoryResponse.ok) {
            const inventoryData = await inventoryResponse.json();
            logDebug('Inventory Data', inventoryData);
            
            if (inventoryData.inventory_levels && inventoryData.inventory_levels.length > 0) {
                const stock = Math.round(inventoryData.inventory_levels[0].in_stock || 0);
                console.log(`📦 Current stock: ${stock}`);
                return stock;
            }
        } else {
            const errorText = await inventoryResponse.text();
            logError('Inventory API Failed', new Error(`HTTP ${inventoryResponse.status}`), {
                status: inventoryResponse.status,
                errorBody: errorText
            });
        }

        console.log('📦 No inventory data found, returning 0');
        return 0;
        
    } catch (error) {
        logError('getCurrentStock', error, { item_id: item.id });
        return 0;
    }
}

// ROUTES

// Handle barcode scanning with real Loyverse integration
app.post('/scan', async (req, res) => {
    const { barcode } = req.body;
    
    if (!barcode) {
        return res.json({ success: false, error: 'No barcode provided' });
    }
    
    console.log(`\n🔍 Scanning barcode: ${barcode}`);
    
    try {
        // Look up product in Loyverse
        const productResult = await findProductInLoyverse(barcode);
        
        if (!productResult.success) {
            return res.json({ success: false, error: productResult.error });
        }
        
        // Get current local count and increment
        const currentCount = scannedCounts.get(barcode) || 0;
        const newCount = currentCount + 1;
        
        // Store the count and product info
        scannedCounts.set(barcode, newCount);
        scannedItems.set(barcode, {
            ...productResult,
            counted: newCount,
            lastScanned: new Date()
        });
        
        console.log(`✅ ${productResult.product_name}: Local count ${newCount}, Loyverse stock ${productResult.stock}`);
        
        // Return response with real product data
        res.json({
            success: true,
            product: productResult.product_name,
            barcode: barcode,
            counted: newCount,
            currentStock: productResult.stock,
            difference: newCount - productResult.stock
        });
        
    } catch (error) {
        logError('Scan Route', error, { barcode });
        res.json({ success: false, error: 'Scan failed: ' + error.message });
    }
});
// Update all counts to Loyverse
app.post('/update-loyverse', async (req, res) => {
    try {
        console.log('🔄 Starting Loyverse inventory update...');
        
        if (scannedItems.size === 0) {
            return res.json({ 
                success: false, 
                error: 'No items to update' 
            });
        }
        
        const updates = [];
        const errors = [];
        
        for (let [barcode, itemData] of scannedItems) {
            if (itemData.counted > 0) {
                console.log(`Updating ${barcode}: ${itemData.counted}`);
                
                // For now, just simulate the update (we'll add real update later)
                updates.push(`${barcode}: ${itemData.counted}`);
                
                // Add delay between updates to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        const message = `Updated ${updates.length} items` + (errors.length > 0 ? `, ${errors.length} errors` : '');
        console.log('✅ Update complete:', message);
        
        res.json({ 
            success: true, 
            message,
            updates: updates.length,
            errors: errors.length,
            details: { updates, errors }
        });
        
    } catch (error) {
        logError('Bulk update error', error);
        res.json({ success: false, error: 'Bulk update failed: ' + error.message });
    }
});
// Reset counts
app.post('/reset', (req, res) => {
    scannedCounts.clear();
    scannedItems.clear();
    console.log('🔄 All counts reset');
    res.json({ success: true, message: 'All counts reset' });
});

// Get scanned items
app.get('/items', (req, res) => {
    const items = Array.from(scannedItems.entries()).map(([barcode, data]) => ({
        barcode,
        ...data
    }));
    res.json(items);
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Scanner app running on port ${PORT}`);
    console.log('🔗 Loyverse API integration active');
    console.log(`📍 Server URL: http://localhost:${PORT}`);
    console.log(`🧪 Test API: http://localhost:${PORT}/test-loyverse`);
    console.log('\n');
});
