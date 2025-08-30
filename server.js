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

// Serve HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// LOYVERSE API FUNCTIONS

async function findProductInLoyverse(barcode) {
    try {
        console.log(`Looking up product: ${barcode}`);
        
        // Search by SKU first
        let url = `${LOYVERSE_API_BASE}/items?sku=${encodeURIComponent(barcode)}&limit=50`;
        let response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.items && data.items.length > 0) {
                const item = data.items[0];
                console.log(`Found product: ${item.item_name}`);
                return {
                    success: true,
                    product_name: item.item_name,
                    category_name: item.category_name || 'Unknown',
                    stock: await getCurrentStock(item),
                    item_id: item.id,
                    item: item
                };
            }
        }

        // Search variants endpoint
        url = `${LOYVERSE_API_BASE}/variants?sku=${encodeURIComponent(barcode)}&limit=50`;
        response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const data = await response.json();
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
                    console.log(`Found product via variant: ${item.item_name}`);
                    return {
                        success: true,
                        product_name: item.item_name,
                        category_name: item.category_name || 'Unknown',
                        stock: await getCurrentStock(item),
                        item_id: item.id,
                        variant_id: variant.id,
                        item: item
                    };
                }
            }
        }

        console.log(`Product not found: ${barcode}`);
        return { success: false, error: `Product not found: ${barcode}` };

    } catch (error) {
        console.error('Loyverse API error:', error);
        return { success: false, error: 'API connection failed' };
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

        if (!storeResponse.ok) return 0;
        
        const storeData = await storeResponse.json();
        if (!storeData.stores || storeData.stores.length === 0) return 0;
        
        const storeId = storeData.stores[0].id;

        // Get inventory levels
        const inventoryResponse = await fetch(`${LOYVERSE_API_BASE}/inventory?store_ids=${storeId}&item_ids=${item.id}`, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (inventoryResponse.ok) {
            const inventoryData = await inventoryResponse.json();
            if (inventoryData.inventory_levels && inventoryData.inventory_levels.length > 0) {
                return Math.round(inventoryData.inventory_levels[0].in_stock || 0);
            }
        }

        return 0;
    } catch (error) {
        console.error('Stock lookup error:', error);
        return 0;
    }
}

async function updateLoyverseInventory(itemData, newCount) {
    try {
        // Get store ID
        const storeResponse = await fetch(`${LOYVERSE_API_BASE}/stores`, {
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!storeResponse.ok) {
            throw new Error('Cannot get store information');
        }
        
        const storeData = await storeResponse.json();
        if (!storeData.stores || storeData.stores.length === 0) {
            throw new Error('No stores found');
        }
        
        const storeId = storeData.stores[0].id;

        // Create inventory adjustment
        const adjustmentPayload = {
            inventory_levels: [{
                item_id: itemData.item_id,
                variant_id: itemData.variant_id || null,
                store_id: storeId,
                stock_after: newCount,
                reason: 'Physical Inventory Count'
            }]
        };

        console.log('Updating Loyverse inventory:', adjustmentPayload);

        const response = await fetch(`${LOYVERSE_API_BASE}/inventory`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(adjustmentPayload)
        });

        if (response.ok) {
            console.log(`Successfully updated ${itemData.item_id} to ${newCount}`);
            return { success: true, message: `Updated to ${newCount} units` };
        } else {
            const errorText = await response.text();
            console.error('Loyverse update failed:', response.status, errorText);
            return { success: false, error: `Update failed: ${response.status}` };
        }

    } catch (error) {
        console.error('Inventory update error:', error);
        return { success: false, error: error.message };
    }
}

// ROUTES

// Handle barcode scanning with real Loyverse integration
app.post('/scan', async (req, res) => {
    const { barcode } = req.body;
    
    if (!barcode) {
        return res.json({ success: false, error: 'No barcode provided' });
    }
    
    console.log(`Scanning barcode: ${barcode}`);
    
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
        
        console.log(`${productResult.product_name}: Local count ${newCount}, Loyverse stock ${productResult.stock}`);
        
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
        console.error('Scan error:', error);
        res.json({ success: false, error: 'Scan failed' });
    }
});

// Update all counts to Loyverse
app.post('/update-loyverse', async (req, res) => {
    try {
        console.log('Starting Loyverse inventory update...');
        
        const updates = [];
        const errors = [];
        
        for (let [barcode, itemData] of scannedItems) {
            if (itemData.counted > 0) {
                console.log(`Updating ${barcode}: ${itemData.counted}`);
                
                const updateResult = await updateLoyverseInventory(itemData, itemData.counted);
                
                if (updateResult.success) {
                    updates.push(`${barcode}: ${itemData.counted}`);
                } else {
                    errors.push(`${barcode}: ${updateResult.error}`);
                }
                
                // Add delay between updates to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
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
        console.error('Bulk update error:', error);
        res.json({ success: false, error: 'Bulk update failed' });
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
    console.log(`Scanner app running on port ${PORT}`);
    console.log('Loyverse API integration active');
});
