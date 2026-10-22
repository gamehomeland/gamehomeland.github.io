import { verifyModelLibrary } from './model-library.mjs';
const report = await verifyModelLibrary();
console.log(
  `内置模型：${report.furniture} 份家具（${report.editableFurniture} 件可编辑）、${report.basements} 份地下室模型包、${report.variants} 个形态，内嵌 ${report.embeddedImages} 张贴图；${(report.bytes / 1024 ** 2).toFixed(1)} MiB`,
);
