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

async function updateLoyverseInventory(itemData, newCount) {
    try {
        logDebug('Starting Loyverse Update', { 
            variant_id: itemData.variant_id, 
            item_id: itemData.item_id,
            newCount 
        });
        
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
        console.log(`📍 Using store ID: ${storeId}`);

        // Check if we have variant_id (we should have it from the SKU search)
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

        logDebug('Loyverse Update Payload (Correct Format)', adjustmentPayload);

        const response = await fetch(`${LOYVERSE_API_BASE}/inventory`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(adjustmentPayload)
        });

        logDebug('Loyverse Update Response', {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok
        });

        if (response.ok) {
            const responseData = await response.json();
            logDebug('Update Success Data', responseData);
            console.log(`✅ Successfully updated variant ${itemData.variant_id} to ${newCount} units`);
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
        logDebug('Product Search Started', { scannedCode });
        
        // STEP 1: Try searching by SKU in variants endpoint first
        console.log(`🔍 Searching variants by SKU: ${scannedCode}`);
        const variantsUrl = `${LOYVERSE_API_BASE}/variants?sku=${encodeURIComponent(scannedCode)}&limit=50`;
        
        logDebug('Variants API Request', { url: variantsUrl });
        
        const variantsResponse = await fetch(variantsUrl, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (variantsResponse.ok) {
            const variantsData = await variantsResponse.json();
            logDebug('Variants API Response Data', variantsData);
            
            if (variantsData.variants && variantsData.variants.length > 0) {
                const variant = variantsData.variants[0];
                console.log(`✅ Found variant by SKU: ${variant.sku}, variant_id: ${variant.id}`);
                
                // Get full item details
                const itemResponse = await fetch(`${LOYVERSE_API_BASE}/items/${variant.item_id}`, {
                    headers: {
                        'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (itemResponse.ok) {
                    const item = await itemResponse.json();
                    console.log(`✅ Found product: ${item.item_name}`);
                    
                    const stock = await getCurrentStock(item);
                    
                    return {
                        success: true,
                        product_name: item.item_name,
                        category_name: item.category_name || 'Unknown',
                        stock: stock,
                        item_id: item.id,
                        variant_id: variant.id,
                        item: item,
                        variant: variant
                    };
                }
            } else {
                console.log(`No variants found via SKU search, trying alternative approach...`);
            }
        }

        // STEP 2: Alternative approach - search items then extract variant_id (Loyverse's fallback)
        console.log(`🔍 Searching items by SKU: ${scannedCode}`);
        const itemsUrl = `${LOYVERSE_API_BASE}/items?sku=${encodeURIComponent(scannedCode)}&limit=50`;
        
        logDebug('Items API Request', { url: itemsUrl });
        
        const itemsResponse = await fetch(itemsUrl, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (itemsResponse.ok) {
            const itemsData = await itemsResponse.json();
            logDebug('Items API Response Data', itemsData);
            
            if (itemsData.items && itemsData.items.length > 0) {
                const item = itemsData.items[0];
                console.log(`✅ Found item by SKU: ${item.item_name}`);
                
                // Debug: Log the entire item structure to see what's available
                console.log(`🔍 Item structure analysis:`);
                console.log(`- Item ID: ${item.id}`);
                console.log(`- Item name: ${item.item_name}`);
                console.log(`- Has variants property: ${!!item.variants}`);
                console.log(`- Variants array length: ${item.variants ? item.variants.length : 'N/A'}`);
                
                if (item.variants) {
                    console.log(`- Variants array content:`, JSON.stringify(item.variants, null, 2));
                } else {
                    console.log(`- No variants property found in item`);
                }
                
                // Try to extract variant_id from the item's variants array
                let variantId = null;
                let variant = null;
                
                if (item.variants && item.variants.length > 0) {
                    variant = item.variants[0]; // Use the first (default) variant
                    variantId = variant.id;
                    console.log(`✅ Extracted variant_id from item.variants: ${variantId}`);
                } else {
                    // Sometimes the variant might be in a different property or structure
                    console.log(`❌ No variants found in item.variants array`);
                    console.log(`🔍 Checking for other variant properties...`);
                    
                    // Log all top-level properties to see what's available
                    console.log(`Available item properties:`, Object.keys(item));
                    
                    // Check if there are any variant-related properties
                    const variantKeys = Object.keys(item).filter(key => 
                        key.toLowerCase().includes('variant') || key.toLowerCase().includes('sku')
                    );
                    console.log(`Variant-related properties:`, variantKeys);
                    
                    // Last resort - try to get variants via a separate API call
                    console.log(`🔍 Trying to fetch variants separately for item ${item.id}...`);
                    try {
                        const variantsForItemResponse = await fetch(`${LOYVERSE_API_BASE}/variants?item_ids=${item.id}&limit=10`, {
                            headers: {
                                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });
                        
                        if (variantsForItemResponse.ok) {
                            const variantsForItemData = await variantsForItemResponse.json();
                            console.log(`Variants API response for item:`, JSON.stringify(variantsForItemData, null, 2));
                            
                            if (variantsForItemData.variants && variantsForItemData.variants.length > 0) {
                                variant = variantsForItemData.variants[0];
                                variantId = variant.id;
                                console.log(`✅ Found variant via separate API call: ${variantId}`);
                            }
                        }
                    } catch (error) {
                        console.log(`❌ Separate variants API call failed:`, error.message);
                    }
                }
                
                if (variantId) {
                    const stock = await getCurrentStock(item);
                    
                    return {
                        success: true,
                        product_name: item.item_name,
                        category_name: item.category_name || 'Unknown',
                        stock: stock,
                        item_id: item.id,
                        variant_id: variantId,
                        item: item,
                        variant: variant
                    };
                } else {
                    console.log(`❌ Could not find variant_id for item ${item.item_name} (${item.id})`);
                    logDebug('Complete item data', item);
                }
            } else {
                console.log(`No items found for SKU: ${scannedCode}`);
            }
        } else {
            const errorText = await itemsResponse.text();
            logError('Items API Failed', new Error(`HTTP ${itemsResponse.status}`), {
                status: itemsResponse.status,
                errorBody: errorText
            });
        }

        console.log(`❌ Product not found: ${scannedCode}`);
        return { success: false, error: `Product with SKU "${scannedCode}" not found` };

    } catch (error) {
        logError('findProductInLoyverse', error, { scannedCode });
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
    
    console.log(`\n🔍 Scanning SKU: ${barcode}`);
    
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
        
        console.log(`✅ ${productResult.product_name}: Local count ${newCount}, Loyverse stock ${productResult.stock}, variant_id: ${productResult.variant_id}`);
        
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
                console.log(`Updating ${barcode}: ${itemData.counted} (variant_id: ${itemData.variant_id})`);
                
                const updateResult = await updateLoyverseInventory(itemData, itemData.counted);
                
                if (updateResult.success) {
                    updates.push(`${barcode}: ${itemData.counted}`);
                    console.log(`✅ ${barcode} updated successfully`);
                } else {
                    errors.push(`${barcode}: ${updateResult.error}`);
                    console.log(`❌ ${barcode} update failed: ${updateResult.error}`);
                }
                
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
    console.log('🔗 Loyverse API integration active (correct workflow)');
    console.log(`📍 Server URL: http://localhost:${PORT}`);
    console.log(`🧪 Test API: http://localhost:${PORT}/test-loyverse`);
    console.log('\n');
});
