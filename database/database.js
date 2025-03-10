require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const db = new sqlite3.Database(process.env.DB_PATH || "./backend/database/users.db", (err) => {
    if (err) {
        console.error("Error opening database: " + err.message);
        process.exit(1); // Exit if the database connection fails
    } else {
        console.log("Connected to the SQLite database.");
        initializeDatabase();
    }
});

async function initializeDatabase() {
    try {
        await createUsersTable();
        await createCreditRequestsTable();
        await createDocumentsTable();
        await createIndexes();
        await createAdminUser();
    } catch (err) {
        console.error("Database initialization error:", err);
    }
}

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

async function createUsersTable() {
    const sql = `
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            credits INTEGER DEFAULT 20
        )`;
    await runQuery(sql);
    console.log("Users table is ready.");
}

async function createCreditRequestsTable() {
    const sql = `
        CREATE TABLE IF NOT EXISTS credit_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            requestedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id)
        )`;
    await runQuery(sql);
    console.log("Credit_requests table is ready.");
}

async function createDocumentsTable() {
    const sql = `
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER NOT NULL,
            filePath TEXT NOT NULL,
            fileName TEXT NOT NULL,
            uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id)
        )`;
    await runQuery(sql);
    console.log("Documents table is ready.");
}

async function createIndexes() {
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_documents_userId ON documents(userId)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_credit_requests_userId ON credit_requests(userId)`);
    console.log("Indexes are ready.");
}

async function createAdminUser() {
    const admin = await getQuery(`SELECT * FROM users WHERE role = 'admin'`);
    if (admin) {
        console.log("Admin user already exists.");
        return;
    }

    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
        console.error("ADMIN_PASSWORD is not set in the environment variables.");
        return;
    }

    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    await runQuery(
        `INSERT INTO users (username, email, password, role, credits)
         VALUES (?, ?, ?, 'admin', 9999)`,
        [process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_EMAIL || 'admin@example.com', hashedPassword]
    );
    console.log("Admin created successfully!");
}

module.exports = db;