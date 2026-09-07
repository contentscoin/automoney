import { describe, expect, it } from "vitest";
import { pickAsset } from "../lib/download";

const win = `version: 0.1.1\nfiles:\n  - url: automoney-agent-0.1.1-win-x64.exe\n    sha512: x\n    size: 1\npath: automoney-agent-0.1.1-win-x64.exe\n`;
const mac = `version: 0.1.1\nfiles:\n  - url: automoney-agent-0.1.1-mac-arm64.zip\n    sha512: x\n  - url: automoney-agent-0.1.1-mac-arm64.dmg\n    sha512: y\npath: automoney-agent-0.1.1-mac-arm64.zip\n`;

describe("/download/[platform] asset pick", () => {
  it("picks the exe from latest.yml and the dmg (not zip) from latest-mac.yml", () => {
    expect(pickAsset(win, /\.exe$/)).toBe("automoney-agent-0.1.1-win-x64.exe");
    expect(pickAsset(mac, /\.dmg$/)).toBe("automoney-agent-0.1.1-mac-arm64.dmg");
    expect(pickAsset(mac, /\.exe$/)).toBeNull();
  });
});
