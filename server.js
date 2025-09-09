require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
// app.use(express.static('public')); // Serve static files

// Amadeus API configuration
const AMADEUS_BASE_URL = 'https://test.api.amadeus.com';
const CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;

// In-memory token storage (use Redis in production)
let tokenCache = {
    token: null,
    expiresAt: null
};

// Get Amadeus access token with caching
async function getAmadeusToken() {
    // Check if we have a valid cached token
    if (tokenCache.token && tokenCache.expiresAt && Date.now() < tokenCache.expiresAt) {
        return tokenCache.token;
    }

    try {
        const response = await fetch(`${AMADEUS_BASE_URL}/v1/security/oauth2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                'grant_type': 'client_credentials',
                'client_id': CLIENT_ID,
                'client_secret': CLIENT_SECRET
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token request failed: ${error}`);
        }

        const data = await response.json();
        
        // Cache the token (expires in 30 minutes, we'll refresh 5 minutes early)
        tokenCache.token = data.access_token;
        tokenCache.expiresAt = Date.now() + (25 * 60 * 1000); // 25 minutes

        console.log('✅ New Amadeus token obtained');
        return data.access_token;
    } catch (error) {
        console.error('❌ Failed to get Amadeus token:', error);
        throw error;
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Flight search API is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Test Amadeus connection
app.get('/api/test-amadeus', async (req, res) => {
    try {
        const token = await getAmadeusToken();
        res.json({
            success: true,
            message: 'Amadeus API connection successful',
            hasToken: !!token
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Flight search endpoint
app.post('/api/search-flights', async (req, res) => {
    try {
        console.log('🔍 Flight search request:', req.body);

        // Validate required fields
        const { origin, destination, departureDate } = req.body;
        if (!origin || !destination || !departureDate) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: origin, destination, departureDate'
            });
        }

        // Get access token
        const accessToken = await getAmadeusToken();
        
        // Build search parameters
        const {
            returnDate,
            adults = 1,
            children = 0,
            infants = 0,
            cabinClass = 'ECONOMY',
            budget,
            maxStops
        } = req.body;
        
        const searchParams = new URLSearchParams({
            'originLocationCode': origin.toUpperCase(),
            'destinationLocationCode': destination.toUpperCase(),
            'departureDate': departureDate,
            'adults': adults.toString(),
            'max': '10'
        });
        
        // Add optional parameters
        if (children > 0) searchParams.append('children', children.toString());
        if (infants > 0) searchParams.append('infants', infants.toString());
        if (returnDate) searchParams.append('returnDate', returnDate);
        if (cabinClass && cabinClass !== 'any') searchParams.append('travelClass', cabinClass);
        if (budget) searchParams.append('maxPrice', budget);
        if (maxStops && maxStops !== 'any') searchParams.append('nonStop', maxStops === '0' ? 'true' : 'false');
        
        console.log('🛫 Searching flights with params:', searchParams.toString());
        
        // Search flights
        const flightResponse = await fetch(`${AMADEUS_BASE_URL}/v2/shopping/flight-offers?${searchParams}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        });
        
        const flightData = await flightResponse.json();
        
        if (!flightResponse.ok) {
            console.error('❌ Amadeus API error:', flightData);
            throw new Error(flightData.errors?.[0]?.detail || `API returned ${flightResponse.status}`);
        }
        
        console.log(`✅ Found ${flightData.data?.length || 0} flights`);
        
        res.json({
            success: true,
            data: flightData.data || [],
            meta: flightData.meta || {},
            count: flightData.data?.length || 0
        });
        
    } catch (error) {
        console.error('❌ Flight search error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: 'Check server logs for more information'
        });
    }
});

// Airport/city search endpoint (for autocomplete)
app.get('/api/locations/:keyword', async (req, res) => {
    try {
        const { keyword } = req.params;
        const accessToken = await getAmadeusToken();
        
        const response = await fetch(`${AMADEUS_BASE_URL}/v1/reference-data/locations?subType=AIRPORT,CITY&keyword=${keyword}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        
        const data = await response.json();
        
        if (response.ok) {
            res.json({
                success: true,
                data: data.data || []
            });
        } else {
            throw new Error(data.errors?.[0]?.detail || 'Location search failed');
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Serve the frontend
app.get('/', (req, res) => {
    res.json({ message: 'Flight Search API is running! Use /api/health to test.' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('💥 Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('🚀 Flight Search Server started');
    console.log(`📍 Server running on http://localhost:${PORT}`);
    console.log(`🔗 API Health: http://localhost:${PORT}/api/health`);
    console.log(`🧪 Test Amadeus: http://localhost:${PORT}/api/test-amadeus`);
    console.log('✈️  Ready to search flights!');
});

module.exports = app;
