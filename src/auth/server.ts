import { OAuth2Client } from 'google-auth-library';
import { TokenManager } from './tokenManager.js';
import http from 'http';
import { URL } from 'url';
import open from 'open';
import { loadCredentials } from './client.js';

export class AuthServer {
  private baseOAuth2Client: OAuth2Client; // Used by TokenManager for validation/refresh
  private flowOAuth2Client: OAuth2Client | null = null; // Used specifically for the auth code flow
  private server: http.Server | null = null;
  private tokenManager: TokenManager;
  private portRange: { start: number; end: number };
  public authCompletedSuccessfully = false; // Flag for standalone script

  constructor(oauth2Client: OAuth2Client) {
    this.baseOAuth2Client = oauth2Client;
    this.tokenManager = new TokenManager(oauth2Client);
    this.portRange = { start: 3000, end: 3004 };
  }

  private createServer(): http.Server {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      
      if (url.pathname === '/') {
        // Root route - show auth link
        const clientForUrl = this.flowOAuth2Client || this.baseOAuth2Client;
        const scopes = ['https://www.googleapis.com/auth/calendar'];
        const authUrl = clientForUrl.generateAuthUrl({
          access_type: 'offline',
          scope: scopes,
          prompt: 'consent'
        });
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Google Calendar Authentication</h1><a href="${authUrl}">Authenticate with Google</a>`);
        
      } else if (url.pathname === '/oauth2callback') {
        // OAuth callback route
        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Authorization code missing');
          return;
        }
        
        if (!this.flowOAuth2Client) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Authentication flow not properly initiated.');
          return;
        }
        
        try {
          const { tokens } = await this.flowOAuth2Client.getToken(code);
          await this.tokenManager.saveTokens(tokens);
          this.authCompletedSuccessfully = true;

          const tokenPath = this.tokenManager.getTokenPath();
          
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Authentication Successful</title>
                <style>
                    body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
                    .container { text-align: center; padding: 2em; background-color: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                    h1 { color: #4CAF50; }
                    p { color: #333; margin-bottom: 0.5em; }
                    code { background-color: #eee; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Authentication Successful!</h1>
                    <p>Your authentication tokens have been saved successfully to:</p>
                    <p><code>${tokenPath}</code></p>
                    <p>You can now close this browser window.</p>
                </div>
            </body>
            </html>
          `);
        } catch (error: unknown) {
          this.authCompletedSuccessfully = false;
          const message = error instanceof Error ? error.message : 'Unknown error';
          
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Authentication Failed</title>
                <style>
                    body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
                    .container { text-align: center; padding: 2em; background-color: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                    h1 { color: #F44336; }
                    p { color: #333; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Authentication Failed</h1>
                    <p>An error occurred during authentication:</p>
                    <p><code>${message}</code></p>
                    <p>Please try again or check the server logs.</p>
                </div>
            </body>
            </html>
          `);
        }
      } else {
        // 404 for other routes
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });
  }

  async start(openBrowser = true): Promise<boolean> {
    if (await this.tokenManager.validateTokens()) {
      this.authCompletedSuccessfully = true;
      return true;
    }
    
    // Try to start the server and get the port
    const port = await this.startServerOnAvailablePort();
    if (port === null) {
      this.authCompletedSuccessfully = false;
      return false;
    }

    // Successfully started server on `port`. Now create the flow-specific OAuth client.
    try {
      const { client_id, client_secret } = await loadCredentials();
      this.flowOAuth2Client = new OAuth2Client(
        client_id,
        client_secret,
        `http://localhost:${port}/oauth2callback`
      );
    } catch (error) {
        // Could not load credentials, cannot proceed with auth flow
        this.authCompletedSuccessfully = false;
        await this.stop(); // Stop the server we just started
        return false;
    }

    if (openBrowser) {
      // Generate Auth URL using the newly created flow client
      const authorizeUrl = this.flowOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
        prompt: 'consent'
      });
      await open(authorizeUrl);
    }

    return true; // Auth flow initiated
  }

  private async startServerOnAvailablePort(): Promise<number | null> {
    for (let port = this.portRange.start; port <= this.portRange.end; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const testServer = this.createServer();
          testServer.listen(port, () => {
            this.server = testServer; // Assign to class property *only* if successful
            resolve();
          });
          testServer.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
              // Port is in use, close the test server and reject
              testServer.close(() => reject(err)); 
            } else {
              // Other error, reject
              reject(err);
            }
          });
        });
        return port; // Port successfully bound
      } catch (error: unknown) {
        // Check if it's EADDRINUSE, otherwise rethrow or handle
        if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) {
            // An unexpected error occurred during server start
            return null;
        }
        // EADDRINUSE occurred, loop continues
      }
    }
    return null; // No port found
  }

  public getRunningPort(): number | null {
    if (this.server) {
      const address = this.server.address();
      if (typeof address === 'object' && address !== null) {
        return address.port;
      }
    }
    return null;
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) {
            reject(err);
          } else {
            this.server = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
} 