# Raft-lite Distributed Key-Value Store

A 3-node distributed key-value store implementing a simplified Raft consensus algorithm.

## Overview

This project implements a distributed system where three nodes work together to maintain a consistent key-value store. The system uses the Raft consensus algorithm to ensure that all nodes agree on the same data, even when some nodes fail.

## Features

- **Leader Election**: Automatic leader election with random timeouts
- **Log Replication**: Data is replicated across all nodes for fault tolerance
- **Persistence**: State and logs are saved to disk
- **Fault Tolerance**: System continues operating even if one node fails
- **HTTP API**: RESTful interface for both internal communication and client operations
- **CLI Tool**: Command-line interface for easy interaction

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Cluster

```bash
./launch.sh
```

This will start three nodes:
- Node A on port 5000
- Node B on port 5001  
- Node C on port 5002

### 3. Interact with the System

```bash
# Check cluster status
./cli status

# Store a key-value pair
./cli put name "John Doe"

# Retrieve a value
./cli get name

# Check status again
./cli status
```

## API Endpoints

### Internal Communication
- `POST /vote` - Leader election voting
- `POST /append` - Log replication

### Client Operations
- `POST /kv` - Store key-value pair
- `GET /kv?key=<key>` - Retrieve value
- `GET /metrics` - Cluster metrics

## Architecture

### Node States
- **Follower**: Receives heartbeats from leader, votes in elections
- **Candidate**: Attempting to become leader
- **Leader**: Handles client requests, replicates log to followers

### Leader Election
1. Nodes start as followers
2. If no heartbeat received within timeout (300-500ms), become candidate
3. Candidate requests votes from all peers
4. If majority votes received, becomes leader
5. Leader sends heartbeats to maintain leadership

### Log Replication
1. Client sends write request to leader
2. Leader appends entry to its log
3. Leader sends entry to all followers
4. When majority confirms, leader commits entry
5. Committed entries are applied to key-value store

## Testing

### Basic Functionality Test
```bash
# Start cluster
./launch.sh

# In another terminal, test operations
node cli.js put test "hello world"
node cli.js get test
node cli.js status
```

### Fault Tolerance Test
```bash
# Start cluster
./launch.sh

# Store some data
node cli.js put x 1
node cli.js put y 2

# Find which node is the leader
node cli.js status

# Kill the leader process (replace A/B/C with actual leader)
# Method 1: Kill by node ID
pkill -f "node.*--id A"  # Kill node A
# OR
pkill -f "node.*--id B"  # Kill node B  
# OR
pkill -f "node.*--id C"  # Kill node C

# Method 2: Kill by port (if you know the leader's port)
# pkill -f "port 5000"  # Kill node on port 5000
# pkill -f "port 5001"  # Kill node on port 5001
# pkill -f "port 5002"  # Kill node on port 5002

# Wait for new leader election
sleep 3
node cli.js status

# Verify data survived
node cli.js get x
node cli.js get y
```

### How to Kill the Leader

There are several ways to kill the leader for testing:

#### Method 1: Kill by Node ID
```bash
# First, find the leader
node cli.js status

# Then kill the specific node (replace A/B/C with the leader)
pkill -f "node.*--id A"  # Kill node A
pkill -f "node.*--id B"  # Kill node B
pkill -f "node.*--id C"  # Kill node C

# CORRECT SYNTAX: Note the space and dot in "node.*--id"
# WRONG: pkill -f "node"--id A
# RIGHT: pkill -f "node.*--id A"
```

#### Method 2: Kill by Port
```bash
# If you know the leader's port
pkill -f "port 5000"  # Kill node on port 5000
pkill -f "port 5001"  # Kill node on port 5001
pkill -f "port 5002"  # Kill node on port 5002
```

#### Method 3: Kill All Nodes
```bash
# Kill all nodes at once
pkill -f "node.*--id"
```

#### Method 4: Find and Kill Leader Process
```bash
# Find the leader process
ps aux | grep "node.*--id" | grep -v grep

# Kill specific process by PID
kill <PID>
```

### Complete Fault Tolerance Test Script
```bash
#!/bin/bash
echo "=== FAULT TOLERANCE TEST ==="

# Start cluster
echo "1. Starting cluster..."
./launch.sh &
sleep 5

# Store test data
echo "2. Storing test data..."
node cli.js put test_key "test_value"
node cli.js put x 1
node cli.js put y 2

# Show initial status
echo "3. Initial cluster status:"
node cli.js status

# Find and kill leader
echo "4. Finding and killing leader..."
LEADER_NODE=$(./cli status | grep "State: leader" -B 1 | grep "Node" | awk '{print $2}' | cut -d: -f2)
echo "Leader is on port: $LEADER_NODE"

if [ "$LEADER_NODE" = "5000" ]; then
    pkill -f "node.*--id A"
elif [ "$LEADER_NODE" = "5001" ]; then
    pkill -f "node.*--id B"
elif [ "$LEADER_NODE" = "5002" ]; then
    pkill -f "node.*--id C"
fi

# Wait for new leader election
echo "5. Waiting for new leader election..."
sleep 5

# Check new status
echo "6. New cluster status:"
./cli status

# Verify data survived
echo "7. Verifying data survived:"
./cli get test_key
./cli get x
./cli get y

echo "8. Test completed!"
```

## File Structure

```
├── node.js          # Main node implementation
├── cli.js           # Command-line interface
├── cli              # Executable wrapper for cli.js (put/get/status)
├── launch.sh        # Cluster startup script
├── package.json     # Dependencies
├── DESIGN.md        # 1-page design document
└── README.md        # This file
```

## Persistence

Each node persists its state to disk:
- `node_A_state.json` - Node A's persistent state
- `node_A_log.json` - Node A's log entries
- Similar files for nodes B and C

## Monitoring

Use the metrics endpoint to monitor cluster health:
```bash
curl http://localhost:5000/metrics
curl http://localhost:5001/metrics  
curl http://localhost:5002/metrics
```

Metrics include:
- Node state (follower/candidate/leader)
- Current term
- Commit index
- Election count
- Log length
- Key-value store size
- Last heartbeat time

## Troubleshooting

### Common Issues

#### 1. Multiple Elections / Election Loops
If you see continuous elections like "Starting election for term X", this indicates a network issue:
```bash
# Kill all nodes and restart
pkill -f "node.*--id"
sleep 2
./launch.sh
```

#### 1.1. JavaScript Errors in Elections
If you see "TypeError: Cannot read properties of undefined (reading 'term')":
```bash
# This is fixed in the latest version, but if you see it:
pkill -f "node.*--id"
sleep 2
./launch.sh
```

#### 1.2. Wrong pkill Syntax
If you get "pkill: only one pattern can be provided":
```bash
# WRONG: pkill -f "node"--id A
# RIGHT: pkill -f "node.*--id A"
# Note the space and dot in "node.*--id"
```

#### 2. No Leader Found
If CLI shows "No leader found":
```bash
# Check if nodes are running
ps aux | grep "node.*--id" | grep -v grep

# Check node status
curl http://localhost:5000/metrics
curl http://localhost:5001/metrics
curl http://localhost:5002/metrics

# Restart if needed
pkill -f "node.*--id"
./launch.sh
```

#### 3. Port Already in Use
If you get "EADDRINUSE" errors:
```bash
# Kill processes using the ports
sudo lsof -ti:5000,5001,5002 | xargs kill -9

# Or kill all node processes
pkill -f "node.*--id"
```

#### 4. Data Not Persisting
Check if state files are being created:
```bash
ls -la node_*_state.json
ls -la node_*_log.json
```

### Manual Leader Election Test
```bash
# Start cluster
./launch.sh

# In another terminal, watch elections
watch -n 1 'node cli.js status | grep -E "(State:|Term:)"'

# Kill leader manually
pkill -f "node.*--id A"  # or B or C

# Watch new election happen
```

### Debug Mode
To see detailed logs, run nodes individually:
```bash
# Terminal 1
node node.js --id A --port 5000 --peers localhost:5001,localhost:5002

# Terminal 2  
node node.js --id B --port 5001 --peers localhost:5000,localhost:5002

# Terminal 3
node node.js --id C --port 5002 --peers localhost:5000,localhost:5001
```
