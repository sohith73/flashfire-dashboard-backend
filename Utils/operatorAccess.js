// Does this Operations document manage this client?
//
// Shared by the operator-only routes that re-check identity against the
// database instead of trusting the dashboard's localStorage role
// (Controllers/operations/JrCredsStatus.js, Controllers/operations/BaseCoverLetter.js).
//
//   1. the operator must be a real Operations document (only @flashfirehq
//      addresses can exist there, so a client address never matches)
//   2. the client must be in its managedUsers, unless the role is admin
//      (admins work across all clients)

export function operatorManagesClient(operator, clientId) {
  if (!operator || !clientId) return false;
  if (operator.role === "admin") return true;
  return (operator.managedUsers || []).some((id) => String(id) === String(clientId));
}
