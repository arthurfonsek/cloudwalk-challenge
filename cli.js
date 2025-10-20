#!/usr/bin/env node

const axios = require('axios');

/**
 * CLI Tool for Raft Cluster
 * 
 * Usage:
 *   node cli.js put key value
 *   node cli.js get key
 *   node cli.js status
 */

class RaftCLI {
    constructor() {
        this.nodes = [
            'localhost:5000',
            'localhost:5001', 
            'localhost:5002'
        ];
    }
    
    /**
     * Find the current leader by checking metrics from all nodes
     */
    async findLeader() {
        for (const node of this.nodes) {
            try {
                const response = await axios.get(`http://${node}/metrics`, { timeout: 1000 });
                if (response.data.state === 'leader') {
                    return node;
                }
            } catch (error) {
                // Node might be down, continue to next
            }
        }
        return null;
    }
    
    /**
     * Put a key-value pair
     */
    async put(key, value) {
        const leader = await this.findLeader();
        if (!leader) {
            console.error('No leader found. Cluster might be down.');
            return;
        }
        
        try {
            const response = await axios.post(`http://${leader}/kv`, {
                key,
                value
            }, { timeout: 5000 });
            
            console.log(`✓ Successfully stored ${key}=${value}`);
        } catch (error) {
            if (error.response && error.response.status === 307) {
                // Redirected to leader, try again
                const location = error.response.headers.location;
                if (location) {
                    const response = await axios.post(location, {
                        key,
                        value
                    }, { timeout: 5000 });
                    console.log(`✓ Successfully stored ${key}=${value}`);
                }
            } else {
                console.error(`Error storing ${key}:`, error.message);
            }
        }
    }
    
    /**
     * Get a value by key
     */
    async get(key) {
        const leader = await this.findLeader();
        if (!leader) {
            console.error('No leader found. Cluster might be down.');
            return;
        }
        
        try {
            const response = await axios.get(`http://${leader}/kv?key=${encodeURIComponent(key)}`, { timeout: 5000 });
            console.log(`${key}=${response.data.value}`);
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log(`Key '${key}' not found`);
            } else {
                console.error(`Error getting ${key}:`, error.message);
            }
        }
    }
    
    /**
     * Show cluster status
     */
    async status() {
        console.log('Cluster Status:');
        console.log('==============');
        
        for (const node of this.nodes) {
            try {
                const response = await axios.get(`http://${node}/metrics`, { timeout: 1000 });
                const metrics = response.data;
                
                console.log(`\nNode ${node}:`);
                console.log(`  State: ${metrics.state}`);
                console.log(`  Term: ${metrics.term}`);
                console.log(`  Commit Index: ${metrics.commitIndex}`);
                console.log(`  Election Count: ${metrics.electionCount}`);
                console.log(`  Log Length: ${metrics.logLength}`);
                console.log(`  KV Store Size: ${metrics.kvStoreSize}`);
                console.log(`  Last Heartbeat: ${metrics.lastHeartbeat}ms ago`);
                
            } catch (error) {
                console.log(`\nNode ${node}: OFFLINE`);
            }
        }
    }
}

// Main execution
async function main() {
    const cli = new RaftCLI();
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage:');
        console.log('  node cli.js put <key> <value>  - Store a key-value pair');
        console.log('  node cli.js get <key>          - Retrieve a value by key');
        console.log('  node cli.js status             - Show cluster status');
        process.exit(1);
    }
    
    const command = args[0];
    
    switch (command) {
        case 'put':
            if (args.length !== 3) {
                console.error('Usage: node cli.js put <key> <value>');
                process.exit(1);
            }
            await cli.put(args[1], args[2]);
            break;
            
        case 'get':
            if (args.length !== 2) {
                console.error('Usage: node cli.js get <key>');
                process.exit(1);
            }
            await cli.get(args[1]);
            break;
            
        case 'status':
            await cli.status();
            break;
            
        default:
            console.error(`Unknown command: ${command}`);
            console.log('Available commands: put, get, status');
            process.exit(1);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('CLI Error:', error.message);
        process.exit(1);
    });
}
