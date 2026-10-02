// Compatibility re-export. The implementation lives in src/tasks/ingress.ts so
// lower layers do not depend on app.
export { assertTaskIngress, taskIngress } from "../tasks/ingress.js";
