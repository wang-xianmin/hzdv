/**
 * 宿主项目适配层（hzdv）
 *
 * 移植到另一项目时：改本文件，指向该项目的 KV / 运维鉴权实现即可。
 * agent 业务代码不要直接 import 宿主路径。
 */

export {
  pickKvBinding,
  kvBindingHint,
} from "../../../functions/lib/kv-binding.js";

export {
  assertOpsAccess,
  opsAuthErrorResponse,
} from "../../../functions/lib/ops-auth.js";
