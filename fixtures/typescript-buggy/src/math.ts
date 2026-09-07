// 这是 coding-agent Suite 使用的故障初始工程；错误故意保留给 Agent 修复。
// 运行时把字符串伪装成 number，TypeScript 通过但行为不符合函数契约。
export function add(a: number, b: number): number {
  return String(a + b) as unknown as number;
}
