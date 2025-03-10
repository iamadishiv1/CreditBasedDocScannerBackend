require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('./database/database');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const levenshtein = require('fast-levenshtein');
const cron = require('node-cron');

const app = express();

// Middleware
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretkey',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, httpOnly: true }
}));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// File upload directory (Only plain text files)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Utility functions
function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getAllQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function saveDocument(filePath, text) {
    return new Promise((resolve, reject) => {
        fs.writeFile(filePath, text, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/public/home.html'));
});

// User Registration
app.post('/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: "All fields are required!" });
    }

    try {
        const user = await getQuery(`SELECT * FROM users WHERE email = ? OR username = ?`, [email, username]);
        if (user) return res.status(400).json({ message: "Email or Username already exists!" });

        const hashedPassword = await bcrypt.hash(password, 10);
        await runQuery(`INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, 'user')`, [username, email, hashedPassword]);
        res.status(201).json({ message: "User registered successfully!" });
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// User Login
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required!" });
    }

    try {
        const user = await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);
        if (!user) return res.status(400).json({ message: "User not found!" });

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) return res.status(401).json({ message: "Invalid credentials!" });

        req.session.user = { id: user.id, username: user.username, role: user.role, credits: user.credits };
        res.status(200).json({ message: "Login successful!", user: req.session.user });
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Logout
app.post('/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: "Logout failed!" });
        res.clearCookie('connect.sid');
        res.status(200).json({ message: "Logged out successfully!" });
    });
});

// User Profile
app.get('/user/profile', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Not Authorized! Please Login" });

    try {
        const user = await getQuery(`SELECT id, username, email, role, credits FROM users WHERE id = ?`, [req.session.user.id]);
        if (!user) return res.status(400).json({ message: "User not found!" });
        res.status(200).json({ user });
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});
// Helper function to calculate similarity between two strings
function calculateSimilarity(text1, text2) {
    if (!text1.length || !text2.length) return 0;
    const maxLength = Math.max(text1.length, text2.length);
    const distance = levenshtein.get(text1, text2);
    return 1 - (distance / maxLength);
}

// Document upload (deducts 1 credit)
app.post('/scan', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ message: "Not Authorized! Please Login" });
    }
    const { text, fileName } = req.body;
    if (!text || !fileName) {
        return res.status(400).json({ message: "Text content and file name are required!" });
    }

    try {
        // Check user credits
        const user = await getQuery(`SELECT credits FROM users WHERE id = ?`, [req.session.user.id]);
        if (!user || user.credits < 1) {
            return res.status(403).json({ message: "Insufficient credits! Please request." });
        }

        // Deduct 1 credit
        await runQuery(`UPDATE users SET credits = credits - 1 WHERE id = ?`, [req.session.user.id]);

        // Save the document locally
        const docId = Date.now();
        const savedFileName = `${docId}_${fileName}`;
        const filePath = path.join(uploadDir, savedFileName);
        await fs.promises.writeFile(filePath, text);

        await runQuery(
            `INSERT INTO documents (userId, filePath, fileName) VALUES (?, ?, ?)`,
            [req.session.user.id, savedFileName, fileName]
        );

        // Compare the uploaded text with all existing documents
        const docs = await getAllQuery(`SELECT filePath, fileName FROM documents WHERE filePath != ?`, [savedFileName]);
        const matches = [];

        for (const doc of docs) {
            try {
                // Construct the full file path
                const existingFilePath = path.join(uploadDir, doc.filePath);
                const existingText = await fs.promises.readFile(existingFilePath, 'utf8');
                const similarity = calculateSimilarity(text, existingText);
                console.log(`Comparing ${fileName} with ${doc.fileName}: Similarity = ${similarity}`);

                if (similarity > 0.6) { // Adjust the threshold as needed
                    matches.push({
                        fileName: doc.fileName,
                        similarity: (similarity * 100).toFixed(2) + '%'
                    });
                }
            }
            catch (err) {
                console.error("Error reading file:", doc.filePath, err);
            }
        }

        console.log("Matches found:", matches);
        res.status(200).json({
            message: "Document uploaded successfully!",
            docId,
            creditsLeft: user.credits - 1,
            fileName,
            matches // Send matches back to the frontend
        });
    }
    catch (error) {
        console.error("Error:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});


// Request Credits
app.post('/credits/request', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Not Authorized! Please Login" });
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ message: "Invalid credit request amount!" });

    try {
        await runQuery(`INSERT INTO credit_requests (userId, amount, status) VALUES (?, ?, 'pending')`, [req.session.user.id, amount]);
        res.status(200).json({ message: "Credit request submitted for admin approval." });
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Admin: Fetch Credit Requests
app.get('/admin/credit-requests', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ message: "Access Denied! Admin only." });
    }

    try {
        const requests = await getAllQuery(`
            SELECT credit_requests.id, users.username, credit_requests.amount
            FROM credit_requests
            JOIN users ON credit_requests.userId = users.id
            WHERE credit_requests.status = 'pending'
        `);
        res.status(200).json(requests);
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Admin: Fetch All Documents
app.get('/admin/documents', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ message: "Access Denied! Admin only." });
    }

    try {
        const docs = await getAllQuery(`SELECT id, filePath, fileName FROM documents`);
        res.status(200).json(docs);
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Admin: Approve Credit Request
app.post('/admin/approve-request/:requestId', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ message: "Access Denied! Admin only." });
    }

    const { requestId } = req.params;

    try {
        const request = await getQuery(`SELECT userId, amount FROM credit_requests WHERE id = ?`, [requestId]);
        if (!request) return res.status(404).json({ message: "Credit request not found." });

        await runQuery(`UPDATE users SET credits = credits + ? WHERE id = ?`, [request.amount, request.userId]);
        await runQuery(`UPDATE credit_requests SET status = 'approved' WHERE id = ?`, [requestId]);
        res.status(200).json({ message: `Approved ${request.amount} credits for user ${request.userId}.` });
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Admin: Reject Credit Request
app.post('/admin/reject-request/:requestId', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ message: "Access Denied! Admin only." });
    }

    const { requestId } = req.params;

    try {
        await runQuery(`UPDATE credit_requests SET status = 'rejected' WHERE id = ?`, [requestId]);
        res.status(200).json({ message: "Credit request rejected successfully!" });
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Admin: Analytics Dashboard
app.get('/admin/analytics', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ message: "Access Denied! Admin only." });
    }

    try {
        const totalScans = await getQuery(`SELECT COUNT(*) AS totalScans FROM documents`);
        const topUsers = await getAllQuery(`
            SELECT users.username, COUNT(documents.id) AS scanCount
            FROM documents
            JOIN users ON documents.userId = users.id
            GROUP BY users.username
            ORDER BY scanCount DESC
        `);

        const docs = await getAllQuery(`SELECT filePath FROM documents`);
        const wordFrequency = {};

        for (const doc of docs) {
            try {
                const text = await fs.promises.readFile(path.join(uploadDir, doc.filePath), 'utf8');

                const words = text.split(/\s+/);
                words.forEach(word => {
                    wordFrequency[word] = (wordFrequency[word] || 0) + 1;
                });
            }
            catch (err) {
                console.error("Error reading file:", doc.filePath, err);
            }
        }

        const mostCommonTopics = Object.entries(wordFrequency)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([word, count]) => ({ word, count }));

        res.status(200).json({
            totalScans: totalScans.totalScans,
            topUsers,
            mostCommonTopics
        });
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// User: Fetch Documents
app.get('/user/documents', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Not Authorized! Please Login" });

    try {
        const docs = await getAllQuery(`SELECT id, filePath, fileName FROM documents WHERE userId = ?`, [req.session.user.id]);
        res.status(200).json(docs);
    } catch (err) {
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Schedule job to reset credits at midnight
cron.schedule('0 0 * * *', async () => {
    console.log("Running credit reset cron job...");
    try {
        const result = await runQuery(`UPDATE users SET credits = 20 WHERE role = 'user'`);
        console.log(`Credits reset for all users. Rows affected: ${result.changes}`);
    } catch (err) {
        console.error("Error resetting credits:", err);
    }
}, { timezone: "UTC" });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});