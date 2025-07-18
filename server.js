require('dotenv').config();
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());

// Disable SSL certificate verification for local development
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// POST endpoint to receive Jira webhook or automation
app.post('/jira-ticket', async (req, res) => {
    const { ticketId } = req.body;
    if (!ticketId) {
        return res.status(400).json({ error: 'Missing ticketId in request body.' });
    }
    try {
        // Log all environment variables
        console.log('--- ENVIRONMENT VARIABLES ---');
        Object.keys(process.env).forEach(key => {
            if (key.includes('JIRA')) {
                console.log(`${key}: ${process.env[key]}`);
            }
        });
        console.log('-----------------------------');
        // Log request body
        console.log('Request body:', req.body);
        // Fetch ticket details from Jira
        const jiraUrl = `${process.env.JIRA_BASE_URL}/rest/api/3/issue/${ticketId}`;
        console.log('Jira API URL:', jiraUrl);
        // Log axios request config
        const axiosConfig = {
            auth: {
                username: process.env.JIRA_EMAIL,
                password: process.env.JIRA_API_TOKEN
            },
            headers: {
                'Accept': 'application/json'
            }
        };
        console.log('Axios config:', axiosConfig);
        const response = await axios.get(jiraUrl, axiosConfig);
        console.log('Jira API response status:', response.status);
        console.log('Jira API response headers:', response.headers);
        console.log('Jira API response data:', response.data);
        const issue = response.data;
        // Extract attachments
        const attachments = issue.fields.attachment || [];
        const attachmentInfo = attachments.map(att => ({
            filename: att.filename,
            mimeType: att.mimeType,
            content: att.content
        }));
        // Check for .evtx files
        const evtxFiles = attachmentInfo.filter(att => att.filename?.toLowerCase().endsWith('.evtx'));
        const hasEvtx = evtxFiles.length > 0;
        console.log('EVTX files found:', evtxFiles.map(f => f.filename));
        // If no .evtx files, add a comment to the ticket
        if (!hasEvtx) {
            const commentUrl = `${process.env.JIRA_BASE_URL}/rest/api/3/issue/${ticketId}/comment`;
            const commentBody = {
                body: {
                    type: 'doc',
                    version: 1,
                    content: [
                        {
                            type: 'paragraph',
                            content: [
                                {
                                    type: 'text',
                                    text: 'No Windows event log (.evtx) file found in attachments.'
                                }
                            ]
                        }
                    ]
                }
            };
            try {
                const commentResp = await axios.post(commentUrl, commentBody, axiosConfig);
                console.log('Added comment to ticket:', commentResp.status);
            } catch (commentErr) {
                console.error('Failed to add comment to ticket:', commentErr.message);
            }
        }
        res.json({ ticketId, attachments: attachmentInfo, hasEvtx, evtxFiles, foundLogFiles: hasEvtx });
    } catch (error) {
        console.error('--- ERROR DETAILS ---');
        console.error('Error fetching Jira ticket:', error.message);
        if (error.response) {
            console.error('Jira API response status:', error.response.status);
            console.error('Jira API response headers:', error.response.headers);
            console.error('Jira API response data:', error.response.data);
        } else if (error.request) {
            console.error('No response received from Jira API:', error.request);
        } else {
            console.error('Error setting up Jira API request:', error.message);
        }
        console.error('----------------------');
        res.status(500).json({ error: 'Failed to fetch ticket from Jira.' });
    }
});

// Step 1: Redirect user to Atlassian for consent
app.get('/oauth/start', (req, res) => {
    const params = {
        audience: 'api.atlassian.com',
        client_id: process.env.OAUTH_CLIENT_ID,
        scope: 'read:jira-work read:attachment:jira write:jira-work offline_access',
        redirect_uri: process.env.OAUTH_REDIRECT_URI,
        state: 'secureRandomState', // Replace with a secure random value in production
        response_type: 'code',
        prompt: 'consent'
    };
    const authUrl = `https://auth.atlassian.com/authorize?${querystring.stringify(params)}`;
    res.redirect(authUrl);
});

// Step 2: Handle callback and exchange code for access token
app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) {
        return res.status(400).send('Missing code in callback');
    }
    try {
        const tokenResponse = await axios.post('https://auth.atlassian.com/oauth/token', {
            grant_type: 'authorization_code',
            client_id: process.env.OAUTH_CLIENT_ID,
            client_secret: process.env.OAUTH_CLIENT_SECRET,
            code,
            redirect_uri: process.env.OAUTH_REDIRECT_URI
        }, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('--- FULL TOKEN RESPONSE ---');
        console.log(JSON.stringify(tokenResponse.data, null, 2));
        console.log('---------------------------');
        const accessToken = tokenResponse.data.access_token;
        const refreshToken = tokenResponse.data.refresh_token;
        // For demo, show both tokens (store securely in production)
        res.send(`Access token: ${accessToken}<br>Refresh token: ${refreshToken}<br><br>Full response:<br><pre>${JSON.stringify(tokenResponse.data, null, 2)}</pre><br>To refresh, POST to /oauth/token with { refreshToken }.`);
    } catch (error) {
        console.error('OAuth token exchange error:', error.response?.data || error.message);
        res.status(500).send('Failed to exchange code for access token');
    }
});

// POST endpoint to refresh access token using refresh_token
app.post('/oauth/token', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.status(400).json({ error: 'Missing refreshToken in request body.' });
    }
    try {
        const tokenResponse = await axios.post('https://auth.atlassian.com/oauth/token', {
            grant_type: 'refresh_token',
            client_id: process.env.OAUTH_CLIENT_ID,
            client_secret: process.env.OAUTH_CLIENT_SECRET,
            refresh_token: refreshToken
        }, {
            headers: { 'Content-Type': 'application/json' }
        });
        const accessToken = tokenResponse.data.access_token;
        const newRefreshToken = tokenResponse.data.refresh_token;
        res.json({ accessToken, refreshToken: newRefreshToken });
    } catch (error) {
        console.error('OAuth token refresh error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to refresh access token.' });
    }
});

// GET endpoint to fetch Jira ticket details and attachments using OAuth access token and cloudid
app.get('/jira-oauth-ticket', async (req, res) => {
    const { ticketId, accessToken, cloudId } = req.query;
    if (!ticketId || !accessToken || !cloudId) {
        return res.status(400).json({ error: 'Missing ticketId, accessToken, or cloudId in query params.' });
    }
    try {
        const jiraUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${ticketId}`;
        const response = await axios.get(jiraUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        });
        const issue = response.data;
        // Extract attachments
        const attachments = issue.fields.attachment || [];
        const attachmentInfo = [];
        for (const att of attachments) {
            let zipContents = null;
            if (att.mimeType === 'application/zip' || att.filename.endsWith('.zip')) {
                try {
                    // Download the ZIP file
                    const zipResponse = await axios.get(att.content, {
                        headers: { 'Authorization': `Bearer ${accessToken}` },
                        responseType: 'arraybuffer'
                    });
                    // Extract ZIP contents
                    const zip = new AdmZip(zipResponse.data);
                    zipContents = zip.getEntries().map(entry => entry.entryName);
                    console.log(`Extracted ZIP contents for ${att.filename}:`, zipContents);
                } catch (zipErr) {
                    console.error(`Failed to extract ZIP ${att.filename}:`, zipErr.message);
                }
            }
            attachmentInfo.push({
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                content: att.content,
                zipContents
            });
        }
        // Check for .evtx files
        const evtxFiles = attachmentInfo.filter(att => att.filename?.toLowerCase().endsWith('.evtx'));
        const hasEvtx = evtxFiles.length > 0;
        console.log('EVTX files found:', evtxFiles.map(f => f.filename));
        // If no .evtx files, add a comment to the ticket
        if (!hasEvtx) {
            const commentUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${ticketId}/comment`;
            const commentBody = {
                body: {
                    type: 'doc',
                    version: 1,
                    content: [
                        {
                            type: 'paragraph',
                            content: [
                                {
                                    type: 'text',
                                    text: 'No Windows event log (.evtx) file found in attachments.'
                                }
                            ]
                        }
                    ]
                }
            };
            try {
                const commentResp = await axios.post(commentUrl, commentBody, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                });
                console.log('Added comment to ticket:', commentResp.status);
            } catch (commentErr) {
                console.error('Failed to add comment to ticket:', commentErr.message);
            }
        }
        res.json({ ticketId, attachments: attachmentInfo, hasEvtx, evtxFiles, foundLogFiles: hasEvtx });
    } catch (error) {
        console.error('--- ERROR DETAILS ---');
        console.error('Error fetching Jira ticket (OAuth):', error.message);
        if (error.response) {
            console.error('Jira API response status:', error.response.status);
            console.error('Jira API response data:', error.response.data);
        } else if (error.request) {
            console.error('No response received from Jira API:', error.request);
        } else {
            console.error('Error setting up Jira API request:', error.message);
        }
        console.error('----------------------');
        res.status(500).json({ error: 'Failed to fetch ticket from Jira (OAuth).' });
    }
});

// GET endpoint to list accessible Jira cloud sites for a given access token
app.get('/jira-cloud-info', async (req, res) => {
    const { accessToken } = req.query;
    if (!accessToken) {
        return res.status(400).json({ error: 'Missing accessToken in query params.' });
    }
    try {
        const url = 'https://api.atlassian.com/oauth/token/accessible-resources';
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        });
        const resources = response.data;
        if (!Array.isArray(resources) || resources.length === 0) {
            console.log('No accessible Jira sites found for this token.');
            return res.json({ resources: [] });
        }
        console.log('--- Accessible Jira Sites ---');
        resources.forEach(site => {
            console.log('Cloud ID:', site.id);
            console.log('Name:', site.name);
            console.log('URL:', site.url);
            console.log('----------------------------');
        });
        res.json({ resources });
    } catch (error) {
        console.error('Error fetching accessible Jira sites:', error.message);
        if (error.response) {
            console.error('API response status:', error.response.status);
            console.error('API response data:', error.response.data);
        }
        res.status(500).json({ error: 'Failed to fetch accessible Jira sites.' });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
