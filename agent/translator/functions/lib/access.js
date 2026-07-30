/**
 * 口译器门禁：从宿主 host 再导出，方便移植时只改 host / translator-auth。
 */
export {
  assertTranslatorAccess,
  translatorAuthErrorResponse,
  pickKvBinding,
} from "../../../functions/lib/host.js";
