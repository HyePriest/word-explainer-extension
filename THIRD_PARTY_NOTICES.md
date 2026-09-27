# 第三方组件声明

以下组件随项目分发。其版权与许可条款以各组件随附文件为准；分发时应保留这些文件。本索引不替代许可证原文，也不为项目自身代码指定许可证。

| 组件 | 随附版本 / 信息 | 许可文件 |
| --- | --- | --- |
| PDF.js / pdfjs-dist | 6.1.200，见 `pdf/vendor/PDFJS-VERSION.txt` | [LICENSE-PDFJS](pdf/vendor/LICENSE-PDFJS) |
| PDF.js CMaps | 随 PDF.js 分发 | [cmaps/LICENSE](pdf/vendor/cmaps/LICENSE) |
| PDF.js ICC profiles | 随 PDF.js 分发 | [iccs/LICENSE](pdf/vendor/iccs/LICENSE) |
| Foxit 字体 | 随 PDF.js 分发 | [LICENSE_FOXIT](pdf/vendor/standard_fonts/LICENSE_FOXIT) |
| Liberation 字体 | 随 PDF.js 分发 | [LICENSE_LIBERATION](pdf/vendor/standard_fonts/LICENSE_LIBERATION) |
| OpenJPEG 及 PDF.js 集成代码 | 随 PDF.js 分发 | [LICENSE_OPENJPEG](pdf/vendor/wasm/LICENSE_OPENJPEG)、[LICENSE_PDFJS_OPENJPEG](pdf/vendor/wasm/LICENSE_PDFJS_OPENJPEG) |
| JBIG2 及 PDF.js 集成代码 | 随 PDF.js 分发 | [LICENSE_JBIG2](pdf/vendor/wasm/LICENSE_JBIG2)、[LICENSE_PDFJS_JBIG2](pdf/vendor/wasm/LICENSE_PDFJS_JBIG2) |
| qcms 及 PDF.js 集成代码 | 随 PDF.js 分发 | [LICENSE_QCMS](pdf/vendor/wasm/LICENSE_QCMS)、[LICENSE_PDFJS_QCMS](pdf/vendor/wasm/LICENSE_PDFJS_QCMS) |
| Tesseract.js | 7.0.0 | [LICENSE-TESSERACTJS.md](pdf/vendor/ocr/LICENSE-TESSERACTJS.md) |
| Tesseract.js Core | 7.0.0 | [LICENSE-TESSERACTCORE](pdf/vendor/ocr/LICENSE-TESSERACTCORE) |

英文识别数据来自 `@tesseract.js-data/eng` 1.0.0（`4.0.0_best_int`）。OCR 组件记录见 [OCR-VERSIONS.txt](pdf/vendor/ocr/OCR-VERSIONS.txt)。

`pdf/vendor/` 中的文件是插件运行所需的随附资源，不应因忽略构建产物而从发布包中移除。
