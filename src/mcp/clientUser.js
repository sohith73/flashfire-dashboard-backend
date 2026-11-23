import { UserModel } from "../../Schema_Models/UserModel.js";

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The client account for an email. Exact match first, which is the common case
// and can use an index; a case-insensitive scan only for legacy mixed-case rows.
export async function findClientUser(email, fields = "_id email name") {
  const exact = await UserModel.findOne({ email }).select(fields).lean();
  if (exact) return exact;
  return UserModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") } })
    .select(fields)
    .lean();
}
