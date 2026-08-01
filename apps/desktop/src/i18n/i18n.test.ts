import { describe, expect, it } from "vitest";
import { en } from "./en";
import { MESSAGE_KEYS } from "./messageKeys";
import { translate } from "./translator";
import { zhCN } from "./zh-CN";

describe("desktop message catalogs", () => {
  it("keeps both locales aligned with the single declared key set", () => {
    const declared = [...MESSAGE_KEYS].sort();

    expect(Object.keys(zhCN).sort()).toEqual(declared);
    expect(Object.keys(en).sort()).toEqual(declared);
  });

  it("interpolates every required value as plain text", () => {
    expect(translate("zh-CN", "budget.toolCalls", { limit: 20, used: 7 })).toBe("工具调用 7 / 20");
    expect(translate("en", "budget.toolCalls", { limit: 20, used: 7 })).toBe("Tool calls 7 / 20");
  });

  it("rejects missing and unexpected interpolation values", () => {
    expect(() => translate("zh-CN", "budget.toolCalls", { used: 7 })).toThrow(
      "missing interpolation parameter: limit",
    );
    expect(() =>
      translate("en", "minecraft.connected", {
        leakedPath: String.raw`C:\Users\private`,
      }),
    ).toThrow("unexpected interpolation parameter: leakedPath");
  });

  it("preserves the canonical owner onboarding copy as intended Unicode", () => {
    expect(zhCN["onboarding.step.owner"]).toBe("\u4e3b\u4eba");
    expect(zhCN["onboarding.owner.title"]).toBe(
      "\u8c01\u662f\u767d\u767e\u5408\u7684\u4e3b\u4eba\uff1f",
    );
    expect(zhCN["onboarding.owner.body"]).toBe(
      "\u586b\u5199\u4f60\u7684 Minecraft Java \u7528\u6237\u540d\u3002\u7528\u6237\u540d\u4e25\u683c\u533a\u5206\u5927\u5c0f\u5199\u3002",
    );
    expect(zhCN["onboarding.owner.label"]).toBe("Minecraft Java \u7528\u6237\u540d");
    expect(zhCN["onboarding.owner.help"]).toBe(
      "\u8bf7\u8f93\u5165 3\u201316 \u4e2a\u82f1\u6587\u5b57\u6bcd\u3001\u6570\u5b57\u6216\u4e0b\u5212\u7ebf\u3002",
    );
    expect(zhCN["onboarding.owner.confirm"]).toBe("\u786e\u8ba4\u4e3b\u4eba\u8eab\u4efd");
    expect(zhCN["onboarding.owner.pending"]).toBe("\u6b63\u5728\u4fdd\u5b58");
    expect(en["onboarding.step.owner"]).toBe("Owner");
    expect(en["onboarding.owner.title"]).toBe("Who should WhiteLily listen to?");
    expect(en["onboarding.owner.label"]).toBe("Minecraft Java username");
  });

  it("keeps live owner switching complete, bilingual, and free of replacement characters", () => {
    expect(en["settings.ownerNewLabel"]).toBe("New owner username");
    expect(en["settings.ownerSwitch"]).toBe("Switch owner");
    expect(en["settings.ownerConfirm"]).toBe("Confirm switch");
    expect(en["settings.ownerMayStopTask"]).toBe("Any active task will stop.");
    expect(zhCN["settings.ownerNewLabel"]).toBe("新主人用户名");
    expect(zhCN["settings.ownerSwitch"]).toBe("切换主人");
    expect(zhCN["settings.ownerConfirm"]).toBe("确认切换");
    expect(zhCN["settings.ownerMayStopTask"]).toBe("任何正在执行的任务都会停止。");
    for (const value of [...Object.values(zhCN), ...Object.values(en)]) {
      expect(value).not.toContain("\ufffd");
    }
  });
});
