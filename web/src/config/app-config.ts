import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "AntiFox",
  version: packageJson.version,
  copyright: `© ${currentYear}, AntiFox.`,
  meta: {
    title: "AntiFox — 自主渗透测试控制台",
    description: "AI 驱动的自主渗透测试平台",
  },
};
