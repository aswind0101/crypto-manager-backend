import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

export async function attachUserRole(req, res, next) {
    const { uid } = req.user;

    try {
        const result = await pool.query("SELECT role FROM users WHERE firebase_uid = $1", [uid]);
        if (result.rows.length > 0) {
            req.user.role = result.rows[0].role;
        } else {
            req.user.role = "KhachHang";
        }
        next();
    } catch (err) {
        console.error("❌ Error attaching user role:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
}
