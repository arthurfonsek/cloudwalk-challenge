#!/bin/bash

# Launch script for 3-node Raft cluster
# This script starts three nodes with different IDs and ports

echo "Starting 3-node Raft cluster..."

# Kill any existing processes on these ports
echo "Cleaning up existing processes..."
pkill -f "node.*--id A" 2>/dev/null || true
pkill -f "node.*--id B" 2>/dev/null || true  
pkill -f "node.*--id C" 2>/dev/null || true

# Wait a moment for cleanup
sleep 1

# Start Node A (port 5000)
echo "Starting Node A on port 5000..."
node node.js --id A --port 5000 --peers localhost:5001,localhost:5002 &
NODE_A_PID=$!

# Start Node B (port 5001) 
echo "Starting Node B on port 5001..."
node node.js --id B --port 5001 --peers localhost:5000,localhost:5002 &
NODE_B_PID=$!

# Start Node C (port 5002)
echo "Starting Node C on port 5002..."
node node.js --id C --port 5002 --peers localhost:5000,localhost:5001 &
NODE_C_PID=$!

# Wait for nodes to start
echo "Waiting for nodes to initialize..."
sleep 3

# Check if nodes are running
echo "Checking node status..."
for port in 5000 5001 5002; do
    if curl -s http://localhost:$port/metrics > /dev/null 2>&1; then
        echo "✓ Node on port $port is running"
    else
        echo "✗ Node on port $port is not responding"
    fi
done

echo ""
echo "Cluster started! Use the following commands to interact:"
echo "  node cli.js status    - Check cluster status"
echo "  node cli.js put k v   - Store key-value pair"
echo "  node cli.js get k     - Retrieve value"
echo ""
echo "Press Ctrl+C to stop all nodes"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Stopping cluster..."
    kill $NODE_A_PID $NODE_B_PID $NODE_C_PID 2>/dev/null || true
    pkill -f "node.*--id A" 2>/dev/null || true
    pkill -f "node.*--id B" 2>/dev/null || true
    pkill -f "node.*--id C" 2>/dev/null || true
    echo "Cluster stopped."
    exit 0
}

# Set trap to cleanup on script exit
trap cleanup SIGINT SIGTERM

# Wait for user to stop
wait
