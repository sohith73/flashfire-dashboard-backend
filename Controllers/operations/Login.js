import Operations from "../../Schema_Models/Operations.js";
import bcrypt from "bcrypt";
import { logActivity } from "../../Utils/activityLogger.js";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

export async function OperationsLogin(req, res) {
     try {
          const { password } = req.body || {};
          const email = normalizeEmail(req.body?.email);

          if (!email || !password) {
               return res.status(400).json({ error: "Email and password are required" });
          }

          const opUser = await Operations.findOne({ email }).populate({
               path: 'managedUsers',
               select: 'userID name email'
          });

          if (!opUser) {
               return res.status(401).json({ error: "Invalid credentials" });
          }

          const isMatch = await bcrypt.compare(password, opUser.password);
          if (!isMatch) {
               return res.status(401).json({ error: "Invalid credentials" });
          }

          // Record the operator login for the admin Activity Monitor.
          logActivity(req, {
               action: "login",
               category: "auth",
               actor: {
                    email: opUser.email,
                    name: opUser.name || "",
                    role: opUser.role || "operations",
                    source: "dashboard",
               },
               summary: `${opUser.name || opUser.email} (operator) logged in`,
          });

          res.json({
               message: "Login successful",
               user: {
                    id: opUser._id,
                    name: opUser.name,
                    email: opUser.email,
                    role: opUser.role,
                    managedUsers: opUser.managedUsers
               },
          });
     } catch (err) {
          console.error("Login error:", err);
          res.status(500).json({ error: "Server error" });
     }
}

export async function OperationsRegister(req, res) {
     try {
          const { email, password } = req.body;

          if (!email || !password) {
               return res.status(400).json({ error: "Email and password are required" });
          }

          // check existing
          const exists = await Operations.findOne({ email });
          if (exists) {
               return res.status(400).json({ error: "Email already registered" });
          }

          // hash password
          const hashed = await bcrypt.hash(password, 10);

          const normalizedOtpEmail = req.body.otpEmail
               ? String(req.body.otpEmail).trim().toLowerCase()
               : null;

          const opUser = new Operations({
               name: email.split("@")[0],
               email,
               password: hashed,
               role: "operations",
               otpEmail: normalizedOtpEmail || undefined,
          });

          await opUser.save();

          res.status(201).json({ message: "Registered successfully", id: opUser._id });
     } catch (err) {
          console.error("Register error:", err);
          res.status(500).json({ error: "Server error" });
     }
}
