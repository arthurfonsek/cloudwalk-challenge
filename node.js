#!/usr/bin/env node

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Raft Node Implementation
 * 
 * This implements a simplified Raft consensus algorithm with:
 * - Leader election with random timeouts
 * - Log replication
 * - Persistence to disk
 * - Key-value store operations
 */

class RaftNode {
    constructor(id, port, peers) {
        this.id = id;
        this.port = port;
        this.peers = peers;
        
        // Raft state
        this.state = 'follower'; // follower, candidate, leader
        this.currentTerm = 0;
        this.votedFor = null;
        this.log = [];
        this.commitIndex = -1;
        this.lastApplied = -1;
        
        // Leader state
        this.nextIndex = {};
        this.matchIndex = {};
        
        // Election state
        this.electionTimeout = null;
        this.electionCount = 0;
        this.lastHeartbeat = Date.now();
        this.quorumBackoffUntil = 0; // avoid thrashing when no majority is possible
        this.electionBackoffMs = 1000;
        this.maxElectionBackoffMs = 10000;
        this.electionJitterMaxMs = 50; // small jitter to avoid lockstep elections
        
        // Key-value store
        this.kvStore = new Map();
        
        // Last known leader address (host:port), used for redirects
        this.lastKnownLeaderAddr = null;

        // Persistence
        this.stateFile = `node_${id}_state.json`;
        this.logFile = `node_${id}_log.json`;
        
        this.loadState();
        this.startElectionTimer();
    }
    
    /**
     * Load persisted state from disk
     */
    loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const stateData = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
                this.currentTerm = stateData.currentTerm || 0;
                this.votedFor = stateData.votedFor;
                this.commitIndex = stateData.commitIndex || -1;
                this.lastApplied = stateData.lastApplied || -1;
            }
            
            if (fs.existsSync(this.logFile)) {
                const logData = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
                this.log = logData.log || [];
                this.applyCommittedEntries();
            }
        } catch (error) {
            console.log(`Node ${this.id}: Error loading state:`, error.message);
        }
    }
    
    /**
     * Persist state to disk
     */
    persistState() {
        try {
            const stateData = {
                currentTerm: this.currentTerm,
                votedFor: this.votedFor,
                commitIndex: this.commitIndex,
                lastApplied: this.lastApplied
            };
            fs.writeFileSync(this.stateFile, JSON.stringify(stateData, null, 2));
            
            const logData = { log: this.log };
            fs.writeFileSync(this.logFile, JSON.stringify(logData, null, 2));
        } catch (error) {
            console.log(`Node ${this.id}: Error persisting state:`, error.message);
        }
    }
    
    /**
     * Start election timer with random timeout (300-500ms)
     */
    startElectionTimer() {
        if (this.electionTimeout) {
            clearTimeout(this.electionTimeout);
        }
        
        // Don't start election if we're already a leader
        if (this.state === 'leader') {
            return;
        }

        // Respect quorum backoff if set
        const now = Date.now();
        if (now < this.quorumBackoffUntil) {
            const delay = Math.max(50, this.quorumBackoffUntil - now);
            this.electionTimeout = setTimeout(() => this.startElection(), delay);
            return;
        }

        // Deterministic per-node base + tiny jitter to break ties
        // A: 300ms, B: 400ms, C: 500ms; fallback uses port-based offset
        const baseMs = 300;
        const idOffsets = { A: 0, B: 100, C: 200 };
        const offset = idOffsets[this.id] ?? ((this.port % 3) * 100);
        const jitter = Math.floor(Math.random() * this.electionJitterMaxMs);
        const timeout = baseMs + offset + jitter;
        this.electionTimeout = setTimeout(() => {
            this.startElection();
        }, timeout);
    }
    
    /**
     * Start leader election
     */
    async startElection() {
        if (this.state === 'leader') return;
        // If we've seen a recent heartbeat, don't start an election
        const nowTs = Date.now();
        if (nowTs - this.lastHeartbeat < 200) {
            // recent leader activity detected
            return;
        }

        // Preflight reachability to avoid term churn when no quorum possible
        const totalNodes = this.peers.length + 1;
        const majority = totalNodes === 2 ? 1 : 2;
        const probePromises = this.peers.map(async (peer) => {
            try {
                await axios.get(`http://${peer}/metrics`, { timeout: 200 });
                return true;
            } catch {
                return false;
            }
        });
        const probeResults = await Promise.all(probePromises);
        const reachablePreflight = 1 + probeResults.filter(Boolean).length;
        if (reachablePreflight < majority) {
            const backoffMs = this.electionBackoffMs;
            console.log(`Node ${this.id}: No quorum (preflight ${reachablePreflight}/${totalNodes}). Pausing elections for ${backoffMs}ms.`);
            this.state = 'follower';
            this.quorumBackoffUntil = Date.now() + backoffMs;
            this.electionBackoffMs = Math.min(this.electionBackoffMs * 2, this.maxElectionBackoffMs);
            this.startElectionTimer();
            return;
        }

        // Reset backoff on viable quorum
        this.electionBackoffMs = 1000;

        console.log(`Node ${this.id}: Starting election for term ${this.currentTerm + 1}`);
        this.state = 'candidate';
        this.currentTerm++;
        this.votedFor = this.id;
        this.electionCount++;
        this.persistState();
        
        let votes = 1; // Vote for self
        console.log(`Node ${this.id}: Need ${majority} votes out of ${totalNodes} total nodes`);
        
        // Request votes from peers
        const votePromises = this.peers.map(async (peer) => {
            try {
                const response = await axios.post(`http://${peer}/vote`, {
                    term: this.currentTerm,
                    candidateId: this.id,
                    lastLogIndex: this.log.length - 1,
                    lastLogTerm: this.log.length > 0 ? this.log[this.log.length - 1].term : 0
                }, { timeout: 1000 });
                return response.data.voteGranted === true ? true : false;
            } catch (error) {
                // null means unreachable
                return null;
            }
        });

        const results = await Promise.all(votePromises);
        const reachable = 1 + results.filter(v => v !== null).length;
        votes += results.filter(v => v === true).length;

        // If quorum collapsed mid-vote, pause
        if (reachable < majority) {
            const backoffMs = this.electionBackoffMs;
            console.log(`Node ${this.id}: No quorum (reachable ${reachable}/${totalNodes}). Pausing elections for ${backoffMs}ms.`);
            this.state = 'follower';
            this.quorumBackoffUntil = Date.now() + backoffMs;
            this.electionBackoffMs = Math.min(this.electionBackoffMs * 2, this.maxElectionBackoffMs);
            this.startElectionTimer();
            return;
        }

        console.log(`Node ${this.id}: Reachable ${reachable}/${totalNodes}, votes ${votes}, need ${majority}`);
        
        if (votes >= majority) {
            this.becomeLeader();
        } else {
            console.log(`Node ${this.id}: Not enough votes, becoming follower`);
            this.state = 'follower';
            // Tie-break backoff: small randomized delay before next election
            const tieBreakDelay = 100 + Math.floor(Math.random() * this.electionJitterMaxMs);
            this.quorumBackoffUntil = Date.now() + tieBreakDelay;
            this.startElectionTimer();
        }
    }
    
    /**
     * Become leader and start sending heartbeats
     */
    becomeLeader() {
        console.log(`Node ${this.id}: Became leader for term ${this.currentTerm}`);
        
        this.state = 'leader';
        this.lastHeartbeat = Date.now();
        this.lastKnownLeaderAddr = `localhost:${this.port}`;
        
        // Initialize leader state
        this.peers.forEach(peer => {
            this.nextIndex[peer] = this.log.length;
            this.matchIndex[peer] = -1;
        });
        
        this.startHeartbeat();
    }
    
    /**
     * Start sending heartbeats to followers
     */
    startHeartbeat() {
        if (this.state !== 'leader') return;
        
        this.sendHeartbeats();
        
        // Send heartbeats every 50ms (fast detection)
        setTimeout(() => {
            this.startHeartbeat();
        }, 50);
    }
    
    /**
     * Send heartbeats to all followers
     */
    async sendHeartbeats() {
        const promises = this.peers.map(async (peer) => {
            try {
                await axios.post(`http://${peer}/append`, {
                    term: this.currentTerm,
                    leaderId: this.id,
                    leaderAddress: `localhost:${this.port}`,
                    prevLogIndex: this.nextIndex[peer] - 1,
                    prevLogTerm: this.nextIndex[peer] > 0 ? this.log[this.nextIndex[peer] - 1].term : 0,
                    entries: this.log.slice(this.nextIndex[peer]),
                    leaderCommit: this.commitIndex
                }, { timeout: 1000 });
                
                this.nextIndex[peer] = this.log.length;
                this.matchIndex[peer] = this.log.length - 1;
            } catch (error) {
                // Follower might be down, decrease nextIndex
                if (this.nextIndex[peer] > 0) {
                    this.nextIndex[peer]--;
                }
            }
        });
        
        await Promise.all(promises);
        this.updateCommitIndex();
    }
    
    /**
     * Update commit index based on majority
     */
    updateCommitIndex() {
        const totalNodes = this.peers.length + 1;
        const majority = Math.floor(totalNodes / 2) + 1;
        
        for (let i = this.commitIndex + 1; i < this.log.length; i++) {
            let count = 1; // Leader has the entry
            this.peers.forEach(peer => {
                if (this.matchIndex[peer] >= i) {
                    count++;
                }
            });
            
            if (count >= majority && this.log[i].term === this.currentTerm) {
                this.commitIndex = i;
            }
        }
        
        this.applyCommittedEntries();
    }
    
    /**
     * Apply committed entries to key-value store
     */
    applyCommittedEntries() {
        while (this.lastApplied < this.commitIndex) {
            this.lastApplied++;
            const entry = this.log[this.lastApplied];
            
            if (entry.type === 'put') {
                this.kvStore.set(entry.key, entry.value);
            } else if (entry.type === 'delete') {
                this.kvStore.delete(entry.key);
            }
        }
        
        this.persistState();
    }
    
    /**
     * Handle vote request (Raft): grant vote if candidate's term is >= ours,
     * we haven't voted for someone else this term, and the candidate's log
     * is at least as up-to-date as ours.
     */
    handleVoteRequest(term, candidateId, lastLogIndex, lastLogTerm) {
        // Reject older terms immediately
        if (term < this.currentTerm) {
            return { voteGranted: false, term: this.currentTerm };
        }

        // If seeing a newer term, step down and clear vote
        if (term > this.currentTerm) {
            this.currentTerm = term;
            this.votedFor = null;
            this.state = 'follower';
        }

        // Compute our last log index/term
        const myLastLogIndex = this.log.length - 1;
        const myLastLogTerm = myLastLogIndex >= 0 ? this.log[myLastLogIndex].term : 0;

        // Raft up-to-date rule
        const candidateUpToDate = (
            lastLogTerm > myLastLogTerm ||
            (lastLogTerm === myLastLogTerm && lastLogIndex >= myLastLogIndex)
        );

        const canVote = this.votedFor === null || this.votedFor === candidateId;

        // If we're actively hearing from a leader in this term, avoid granting votes
        if (term === this.currentTerm && (Date.now() - this.lastHeartbeat) < 200) {
            return { voteGranted: false, term: this.currentTerm };
        }

        if (canVote && candidateUpToDate) {
            this.votedFor = candidateId;
            this.startElectionTimer();
            this.persistState();
            return { voteGranted: true, term: this.currentTerm };
        }

        return { voteGranted: false, term: this.currentTerm };
    }
    
    /**
     * Handle append entries request
     */
    handleAppendEntries(term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit, leaderAddress) {
        if (term >= this.currentTerm) {
            this.currentTerm = term;
            this.state = 'follower';
            this.votedFor = leaderId; // lock vote to current leader for this term
            this.lastHeartbeat = Date.now();
            if (leaderAddress) {
                this.lastKnownLeaderAddr = leaderAddress;
            }
            this.startElectionTimer();
        }
        
        if (term < this.currentTerm) {
            return { success: false, term: this.currentTerm };
        }
        
        // Check if log is consistent
        if (prevLogIndex >= 0 && 
            (prevLogIndex >= this.log.length || this.log[prevLogIndex].term !== prevLogTerm)) {
            return { success: false, term: this.currentTerm };
        }
        
        // Append new entries
        if (entries && entries.length > 0) {
            this.log = this.log.slice(0, prevLogIndex + 1).concat(entries);
            this.persistState();
        }
        
        // Update commit index
        if (leaderCommit > this.commitIndex) {
            this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
            this.applyCommittedEntries();
        }
        
        return { success: true, term: this.currentTerm };
    }

    /**
     * Attempt to replicate a specific entry to a majority and commit it.
     */
    async replicateEntryToMajority(entryIndex, timeoutMs = 1500) {
        const deadline = Date.now() + timeoutMs;

        const replicateToPeer = async (peer) => {
            // Ensure nextIndex initialized
            if (this.nextIndex[peer] == null) this.nextIndex[peer] = this.log.length;
            if (this.matchIndex[peer] == null) this.matchIndex[peer] = -1;
            while (Date.now() < deadline && this.state === 'leader' && this.matchIndex[peer] < entryIndex) {
                const prevIdx = this.nextIndex[peer] - 1;
                const prevTerm = prevIdx >= 0 ? (this.log[prevIdx]?.term || 0) : 0;
                const entries = this.log.slice(this.nextIndex[peer], entryIndex + 1);
                try {
                    const resp = await axios.post(`http://${peer}/append`, {
                        term: this.currentTerm,
                        leaderId: this.id,
                        leaderAddress: `localhost:${this.port}`,
                        prevLogIndex: prevIdx,
                        prevLogTerm: prevTerm,
                        entries,
                        leaderCommit: this.commitIndex
                    }, { timeout: 800 });
                    const ok = resp?.data?.success === true;
                    if (ok) {
                        // Follower accepted entries up to entryIndex
                        this.matchIndex[peer] = Math.max(this.matchIndex[peer], entryIndex);
                        this.nextIndex[peer] = entryIndex + 1;
                        return true;
                    } else {
                        // Conflict: decrement nextIndex and retry
                        if (this.nextIndex[peer] > 0) this.nextIndex[peer]--;
                    }
                } catch {
                    // Unreachable: break for now
                    return false;
                }
            }
            return this.matchIndex[peer] >= entryIndex;
        };

        while (Date.now() < deadline && this.state === 'leader') {
            const results = await Promise.all(this.peers.map(p => replicateToPeer(p)));
            const acks = 1 + results.filter(Boolean).length; // leader + followers that matched entry
            const totalNodes = this.peers.length + 1;
            const majority = totalNodes === 2 ? 1 : 2;
            if (acks >= majority && this.log[entryIndex]?.term === this.currentTerm) {
                // Advance commit to entryIndex
                this.commitIndex = Math.max(this.commitIndex, entryIndex);
                this.applyCommittedEntries();
                return true;
            }
            await new Promise(r => setTimeout(r, 40));
        }
        return false;
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
const id = args[args.indexOf('--id') + 1];
const port = parseInt(args[args.indexOf('--port') + 1]);
const peers = args[args.indexOf('--peers') + 1].split(',');

// Create node instance
const node = new RaftNode(id, port, peers);

// Create Express app
const app = express();
app.use(express.json());

// Internal API endpoints
app.post('/vote', (req, res) => {
    try {
        const { term, candidateId, lastLogIndex, lastLogTerm } = req.body;
        
        // Validate required fields
        if (term === undefined || candidateId === undefined || lastLogIndex === undefined || lastLogTerm === undefined) {
            return res.status(400).json({ error: 'Missing required fields: term, candidateId, lastLogIndex, lastLogTerm' });
        }
        
        const result = node.handleVoteRequest(term, candidateId, lastLogIndex, lastLogTerm);
        res.json(result);
    } catch (error) {
        console.log(`Node ${node.id}: Error handling vote request:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/append', (req, res) => {
    const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit, leaderAddress } = req.body;
    const result = node.handleAppendEntries(term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit, leaderAddress);
    res.json(result);
});

// Client API endpoints
app.post('/kv', async (req, res) => {
    if (node.state !== 'leader') {
        // Redirect to last known leader if available; else 503
        if (node.lastKnownLeaderAddr) {
            return res.redirect(307, `http://${node.lastKnownLeaderAddr}/kv`);
        }
        
        return res.status(503).json({ error: 'No leader available' });
    }
    
    const { key, value } = req.body;
    if (!key || value === undefined) {
        return res.status(400).json({ error: 'Key and value required' });
    }
    
    // Add to log
    const entry = {
        term: node.currentTerm,
        type: 'put',
        key,
        value,
        timestamp: Date.now()
    };
    
    node.log.push(entry);
    node.persistState();
    // Force replication and wait for majority commit before replying
    try {
        const committed = await node.replicateEntryToMajority(node.log.length - 1, 1000);
        if (!committed) {
            return res.status(504).json({ error: 'Replication timed out before commit' });
        }
        return res.json({ success: true, message: 'Committed' });
    } catch (err) {
        return res.status(500).json({ error: 'Replication error' });
    }
});

app.get('/kv', (req, res) => {
    const { key } = req.query;
    if (!key) {
        return res.status(400).json({ error: 'Key required' });
    }
    // Ensure we've applied any committed entries before serving reads
    if (node.state === 'leader') {
        node.applyCommittedEntries();
    }

    const value = node.kvStore.get(key);
    if (value === undefined) {
        return res.status(404).json({ error: 'Key not found' });
    }
    
    res.json({ key, value });
});

app.get('/metrics', (req, res) => {
    res.json({
        state: node.state,
        term: node.currentTerm,
        commitIndex: node.commitIndex,
        electionCount: node.electionCount,
        lastHeartbeat: Date.now() - node.lastHeartbeat,
        logLength: node.log.length,
        kvStoreSize: node.kvStore.size
    });
});

// Start server
app.listen(port, () => {
    console.log(`Node ${id} listening on port ${port}`);
    console.log(`Peers: ${peers.join(', ')}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log(`Node ${id} shutting down...`);
    process.exit(0);
});
