// backend/middleware/checkRole.js

const checkRole = (allowedRoles = []) => {
    return (req, res, next) => {
        const userRole = req.user.role;  // đã gán từ verifyToken
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ error: "Forbidden: insufficient role" });
        }
        next();
    };
};

export default checkRole;
