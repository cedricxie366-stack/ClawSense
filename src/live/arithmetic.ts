/** Small, explicit arithmetic uses a deterministic tool, not a language-model guess. */
export function answerSimpleArithmetic(query: string): string | undefined {
  const number = "[0-9零〇一二两三四五六七八九十点.]+";
  const match = query.match(new RegExp(`(${number})\\s*(加|减|乘以?|除以?|[+×÷*/-])\\s*(${number})(?:等于|是)?(?:多少|多|几)?[？?。!！\\s]*$`));
  if (!match) return;
  if (/[+×÷*/-]|加|减|乘|除|负/.test(query.slice(0, match.index))) return;
  function parse(text: string): number | undefined {
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    const digits: Record<string,number> = {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    if (text.length === 1 && text !== "十") return digits[text];
    if (/^[一二两三四五六七八九]?十[一二三四五六七八九]?$/.test(text)) { const [t,u] = text.split("十"); return (t ? digits[t]! : 1) * 10 + (u ? digits[u]! : 0); }
  }
  const a=parse(match[1]!), b=parse(match[3]!); if(a===undefined || b===undefined || a>1e9 || b>1e9)return;
  const op=match[2]!; if(/除|[÷/]/.test(op) && b===0)return "除数不能为零。";
  const value=/加|\+/.test(op)?a+b:/减|-/.test(op)?a-b:/乘|[×*]/.test(op)?a*b:a/b;
  if(!Number.isFinite(value) || Math.abs(value)>1e12)return;
  return `结果是${Number.isInteger(value) ? value : Number(value.toPrecision(12))}。`;
}
