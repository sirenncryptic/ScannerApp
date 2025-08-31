require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Loyverse API configuration
const LOYVERSE_TOKEN = process.env.LOYVERSE_API_TOKEN;
const LOYVERSE_API_BASE = 'https://api.loyverse.com/v1.0';

// Store scan counts and inventory data
const scannedCounts = new Map();
const scannedItems = new Map();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Serve service worker from root
app.get('/sw.js', (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'sw.js'));
});

// Serve manifest from root  
app.get('/manifest.json', (req, res) => {
    res.set('Content-Type', 'application/json');
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

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

        if (response.ok) {
            const data = await response.json();
            res.json({ 
                success: true, 
                message: 'Loyverse API connected successfully!',
                stores: data.stores ? data.stores.length : 0
            });
        } else {
            const errorText = await response.text();
            res.json({ 
                success: false, 
                error: `API Error: ${response.status} ${response.statusText}`,
                details: errorText
            });
        }
    } catch (error) {
        res.json({ 
            success: false, 
            error: 'Connection failed',
            details: error.message
        });
    }
});

// LOYVERSE API FUNCTIONS

async function updateLoyverseInventory(itemData, newCount) {
    try {
        console.log(`Starting inventory update for variant_id: ${itemData.variant_id}`);
        
        // Get store ID
        const storeResponse = await fetch(`${LOYVERSE_API_BASE}/stores`, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!storeResponse.ok) {
            throw new Error(`Cannot get store information: ${storeResponse.status}`);
        }
        
        const storeData = await storeResponse.json();
        if (!storeData.stores || storeData.stores.length === 0) {
            throw new Error('No stores found');
        }
        
        const storeId = storeData.stores[0].id;
        console.log(`Using store ID: ${storeId}`);

        // Check if we have variant_id
        if (!itemData.variant_id) {
            throw new Error('No variant_id available - this should have been set during product lookup');
        }

        // Create inventory adjustment payload using Loyverse's exact format
        const adjustmentPayload = {
            inventory_levels: [{
                variant_id: itemData.variant_id,
                store_id: storeId,
                stock_after: newCount
            }]
        };

        console.log(`Updating inventory with payload:`, JSON.stringify(adjustmentPayload, null, 2));

        const response = await fetch(`${LOYVERSE_API_BASE}/inventory`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(adjustmentPayload)
        });

        if (response.ok) {
            const responseData = await response.json();
            console.log(`Successfully updated variant ${itemData.variant_id} to ${newCount} units`);
            return { success: true, message: `Updated to ${newCount} units` };
        } else {
            const errorText = await response.text();
            logError('Loyverse Update Failed', new Error(`HTTP ${response.status}`), {
                status: response.status,
                statusText: response.statusText,
                errorBody: errorText,
                payload: adjustmentPayload
            });
            return { success: false, error: `Update failed: ${response.status} - ${errorText}` };
        }

    } catch (error) {
        logError('updateLoyverseInventory', error, { 
            variant_id: itemData.variant_id,
            item_id: itemData.item_id,
            newCount 
        });
        return { success: false, error: error.message };
    }
}

async function findProductInLoyverse(scannedCode) {
    try {
        console.log(`Searching for product with SKU: ${scannedCode}`);
        
        // STEP 1: Search by SKU in variants endpoint (Loyverse recommended approach)
        const variantsUrl = `${LOYVERSE_API_BASE}/variants?sku=${encodeURIComponent(scannedCode)}&limit=50`;
        
        const variantsResponse = await fetch(variantsUrl, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (variantsResponse.ok) {
            const variantsData = await variantsResponse.json();
            console.log(`Variants search returned ${variantsData.variants ? variantsData.variants.length : 0} results`);
            
            if (variantsData.variants && variantsData.variants.length > 0) {
                const variant = variantsData.variants[0];
                console.log(`Found variant: SKU=${variant.sku}, variant_id=${variant.variant_id}`);
                
                // Get full item details
                const itemResponse = await fetch(`${LOYVERSE_API_BASE}/items/${variant.item_id}`, {
                    headers: {
                        'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (itemResponse.ok) {
                    const item = await itemResponse.json();
                    console.log(`Found product: ${item.item_name}`);
                    
                    const stock = await getCurrentStock(item);
                    
                    const result = {
                        success: true,
                        product_name: item.item_name,
                        category_name: item.category_name || 'Unknown',
                        stock: stock,
                        item_id: item.id,
                        variant_id: variant.variant_id, // FIXED: Use variant_id instead of id
                        item: item,
                        variant: variant
                    };
                    
                    console.log(`Returning result with variant_id: ${result.variant_id}`);
                    return result;
                }
            } else {
                console.log(`No variants found for SKU: ${scannedCode}`);
            }
        }

        // STEP 2: Alternative approach - search items then get variants
        console.log(`Trying items search for SKU: ${scannedCode}`);
        const itemsUrl = `${LOYVERSE_API_BASE}/items?sku=${encodeURIComponent(scannedCode)}&limit=50`;
        
        const itemsResponse = await fetch(itemsUrl, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (itemsResponse.ok) {
            const itemsData = await itemsResponse.json();
            
            if (itemsData.items && itemsData.items.length > 0) {
                const item = itemsData.items[0];
                console.log(`Found item: ${item.item_name}`);
                
                // Get variants for this item
                const variantsForItemResponse = await fetch(`${LOYVERSE_API_BASE}/variants?item_ids=${item.id}&limit=10`, {
                    headers: {
                        'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (variantsForItemResponse.ok) {
                    const variantsForItemData = await variantsForItemResponse.json();
                    
                    if (variantsForItemData.variants && variantsForItemData.variants.length > 0) {
                        const variant = variantsForItemData.variants[0];
                        console.log(`Found variant via item lookup: ${variant.variant_id}`);
                        
                        const stock = await getCurrentStock(item);
                        
                        const result = {
                            success: true,
                            product_name: item.item_name,
                            category_name: item.category_name || 'Unknown',
                            stock: stock,
                            item_id: item.id,
                            variant_id: variant.variant_id, // FIXED: Use variant_id instead of id
                            item: item,
                            variant: variant
                        };
                        
                        console.log(`Returning result with variant_id: ${result.variant_id}`);
                        return result;
                    }
                }
            }
        }

        console.log(`Product not found: ${scannedCode}`);
        return { success: false, error: `Product with SKU "${scannedCode}" not found` };

    } catch (error) {
        logError('findProductInLoyverse', error, { scannedCode });
        return { success: false, error: 'API connection failed: ' + error.message };
    }
}

async function getCurrentStock(item) {
    try {
        // Get store ID first
        const storeResponse = await fetch(`${LOYVERSE_API_BASE}/stores`, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!storeResponse.ok) {
            return 0;
        }
        
        const storeData = await storeResponse.json();
        
        if (!storeData.stores || storeData.stores.length === 0) {
            return 0;
        }
        
        const storeId = storeData.stores[0].id;

        // Get inventory levels
        const inventoryUrl = `${LOYVERSE_API_BASE}/inventory?store_ids=${storeId}&item_ids=${item.id}`;
        
        const inventoryResponse = await fetch(inventoryUrl, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (inventoryResponse.ok) {
            const inventoryData = await inventoryResponse.json();
            
            if (inventoryData.inventory_levels && inventoryData.inventory_levels.length > 0) {
                const stock = Math.round(inventoryData.inventory_levels[0].in_stock || 0);
                return stock;
            }
        }

        return 0;
        
    } catch (error) {
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
    
    console.log(`\nScanning SKU: ${barcode}`);
    
    try {
        // Look up product in Loyverse using SKU search
        const productResult = await findProductInLoyverse(barcode);
        
        if (!productResult.success) {
            return res.json({ success: false, error: productResult.error });
        }
        
        // Get current local count and increment
        const currentCount = scannedCounts.get(barcode) || 0;
        const newCount = currentCount + 1;
        
        // Store the count and product info (including variant_id!)
        scannedCounts.set(barcode, newCount);
        scannedItems.set(barcode, {
            ...productResult,
            counted: newCount,
            lastScanned: new Date()
        });
        
        console.log(`${productResult.product_name}: Local count ${newCount}, Loyverse stock ${productResult.stock}, variant_id: ${productResult.variant_id}`);
        
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
        console.log('Starting Loyverse inventory update...');
        
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
                console.log(`Updating ${barcode}: ${itemData.counted} (variant_id: ${itemData.variant_id})`);
                
                const updateResult = await updateLoyverseInventory(itemData, itemData.counted);
                
                if (updateResult.success) {
                    updates.push(`${barcode}: ${itemData.counted}`);
                    console.log(`${barcode} updated successfully`);
                } else {
                    errors.push(`${barcode}: ${updateResult.error}`);
                    console.log(`${barcode} update failed: ${updateResult.error}`);
                }
                
                // Add delay between updates to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        const message = `Updated ${updates.length} items` + (errors.length > 0 ? `, ${errors.length} errors` : '');
        console.log('Update complete:', message);
        
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
    console.log('All counts reset');
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
    console.log(`\nScanner app running on port ${PORT}`);
    console.log('Loyverse API integration active');
    console.log(`Server URL: http://localhost:${PORT}`);
    console.log(`Test API: http://localhost:${PORT}/test-loyverse`);
    console.log('\n');
});
