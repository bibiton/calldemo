/** Vite `?raw` 匯入（測試用：原始碼靜態檢查）。 */
declare module "*?raw" {
  const src: string;
  export default src;
}
