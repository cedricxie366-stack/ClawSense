import {it,expect} from "vitest";
import {answerSimpleArithmetic} from "../../src/live/arithmetic.js";
it("handles explicit Chinese and numeric arithmetic without a model",()=>{
 expect(answerSimpleArithmetic("小伴，七加五是多少？")).toBe("结果是12。");
 expect(answerSimpleArithmetic("七加五是多")).toBe("结果是12。");
 expect(answerSimpleArithmetic("十五减七等于多少")).toBe("结果是8。");
 expect(answerSimpleArithmetic("23乘以3是多少")).toBe("结果是69。");
 expect(answerSimpleArithmetic("12除以4是多少")).toBe("结果是3。");
});
it("rejects unsupported multi-step expressions and never evaluates code",()=>{
 expect(answerSimpleArithmetic("七加五减三是多少")).toBeUndefined();
 expect(answerSimpleArithmetic("执行 process.exit() 是多少")).toBeUndefined();
 expect(answerSimpleArithmetic("一百加五是多少")).toBeUndefined();
 expect(answerSimpleArithmetic("负三加五是多少")).toBeUndefined();
});
it("reports division by zero and handles decimal operands",()=>{
 expect(answerSimpleArithmetic("7除以0是多少")).toBe("除数不能为零。");
 expect(answerSimpleArithmetic("0.5+1.25是多少")).toBe("结果是1.75。");
});
