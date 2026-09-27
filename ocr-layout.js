(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WordExplainerOcrLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ANALYSIS_WIDTH = 720;
  const MAX_ANALYSIS_HEIGHT = 480;

  function percentile(values, ratio) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
  }

  function analyzeTextLines(imageData, width, height) {
    const data = imageData?.data || imageData;
    if (!data || !Number.isFinite(width) || !Number.isFinite(height) || width < 8 || height < 5) {
      return { lineCount: 0, confidentSingleLine: false, bands: [] };
    }

    const stepX = Math.max(1, Math.ceil(width / MAX_ANALYSIS_WIDTH));
    const stepY = Math.max(1, Math.ceil(height / MAX_ANALYSIS_HEIGHT));
    const sampledWidth = Math.ceil(width / stepX);
    const sampledHeight = Math.ceil(height / stepY);
    const rowScores = new Array(sampledHeight).fill(0);

    for (let sampleY = 0, y = 0; sampleY < sampledHeight; sampleY += 1, y += stepY) {
      const actualY = Math.min(height - 1, y);
      let previousIndex = (actualY * width) * 4;
      let previousR = data[previousIndex];
      let previousG = data[previousIndex + 1];
      let previousB = data[previousIndex + 2];
      let transitions = 0;

      for (let x = stepX; x < width; x += stepX) {
        const index = (actualY * width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const colorChange = Math.abs(r - previousR) + Math.abs(g - previousG) + Math.abs(b - previousB);
        if (colorChange >= 72) transitions += 1;
        previousR = r;
        previousG = g;
        previousB = b;
      }
      rowScores[sampleY] = transitions;
    }

    const peak = Math.max(0, ...rowScores);
    const backgroundNoise = percentile(rowScores, 0.5);
    const threshold = Math.max(2, Math.ceil(backgroundNoise * 2.5), Math.ceil(peak * 0.18));
    const active = rowScores.map((score) => score >= threshold);

    // 抗锯齿字形中间偶尔会出现一两行低分，把这些小缝连接起来；
    // 真正的行间距通常明显大于这个范围。
    for (let index = 1; index < active.length - 1; index += 1) {
      if (active[index]) continue;
      let gapEnd = index;
      while (gapEnd < active.length && !active[gapEnd]) gapEnd += 1;
      if (active[index - 1] && gapEnd < active.length && gapEnd - index <= 2) {
        for (let fill = index; fill < gapEnd; fill += 1) active[fill] = true;
      }
      index = gapEnd - 1;
    }

    const bands = [];
    for (let index = 0; index < active.length; index += 1) {
      if (!active[index]) continue;
      const start = index;
      let score = 0;
      while (index < active.length && active[index]) {
        score += rowScores[index];
        index += 1;
      }
      const end = index - 1;
      if (end - start + 1 >= 2 && score >= threshold * 2) {
        bands.push({ start, end, score });
      }
    }

    const singleBand = bands.length === 1 ? bands[0] : null;
    const bandHeight = singleBand ? singleBand.end - singleBand.start + 1 : 0;
    const confidentSingleLine = !!singleBand
      && peak >= Math.max(4, Math.ceil(sampledWidth * 0.006))
      && bandHeight <= sampledHeight * 0.72;

    return {
      lineCount: bands.length,
      confidentSingleLine,
      bands,
      sampledWidth,
      sampledHeight,
      threshold,
      peak,
    };
  }

  function chooseOcrPageSegmentation(imageData, width, height, PSM) {
    const analysis = analyzeTextLines(imageData, width, height);
    const multiLineMode = PSM?.SINGLE_BLOCK ?? PSM?.AUTO;
    return {
      mode: analysis.confidentSingleLine ? PSM?.SINGLE_LINE : multiLineMode,
      analysis,
    };
  }

  function chooseCanvasPageSegmentation(canvas, PSM) {
    try {
      const scale = Math.min(
        1,
        MAX_ANALYSIS_WIDTH / Math.max(1, canvas.width),
        MAX_ANALYSIS_HEIGHT / Math.max(1, canvas.height)
      );
      const width = Math.max(1, Math.round(canvas.width * scale));
      const height = Math.max(1, Math.round(canvas.height * scale));
      let analysisCanvas = canvas;
      if (width !== canvas.width || height !== canvas.height) {
        analysisCanvas = document.createElement('canvas');
        analysisCanvas.width = width;
        analysisCanvas.height = height;
        const analysisContext = analysisCanvas.getContext('2d', { alpha: false });
        analysisContext.drawImage(canvas, 0, 0, width, height);
      }
      const context = analysisCanvas.getContext('2d', { willReadFrequently: true });
      const imageData = context.getImageData(0, 0, width, height);
      const result = chooseOcrPageSegmentation(imageData, width, height, PSM);
      if (analysisCanvas !== canvas) {
        analysisCanvas.width = 0;
        analysisCanvas.height = 0;
      }
      return result;
    } catch (_) {
      return {
        mode: PSM?.SINGLE_BLOCK ?? PSM?.AUTO,
        analysis: { lineCount: 0, confidentSingleLine: false, bands: [] },
      };
    }
  }

  function getTextLineRegions(analysis, width, height, options = {}) {
    const bands = Array.isArray(analysis?.bands) ? analysis.bands : [];
    const sampledHeight = Number(analysis?.sampledHeight) || 0;
    const maxLines = Number.isFinite(options.maxLines) ? options.maxLines : 12;
    if (bands.length < 2 || bands.length > maxLines || sampledHeight < 1 || width < 1 || height < 1) {
      return [];
    }

    const scaleY = height / sampledHeight;
    return bands.map((band, index) => {
      const previous = bands[index - 1];
      const next = bands[index + 1];
      const bandHeight = Math.max(1, band.end - band.start + 1);
      const outerPadding = Math.max(2, Math.min(8, Math.ceil(bandHeight * 0.45)));
      const topSample = previous
        ? (previous.end + band.start + 1) / 2
        : Math.max(0, band.start - outerPadding);
      const bottomSample = next
        ? (band.end + next.start + 1) / 2
        : Math.min(sampledHeight, band.end + 1 + outerPadding);
      // 相邻两行共用同一个取整后的中点边界，避免逐行裁剪出现一像素重叠。
      const top = Math.max(0, Math.round(topSample * scaleY));
      const bottom = Math.min(height, Math.round(bottomSample * scaleY));
      return {
        left: 0,
        top,
        width,
        height: Math.max(1, bottom - top),
        textTop: Math.max(0, Math.floor(band.start * scaleY)),
        textBottom: Math.min(height, Math.ceil((band.end + 1) * scaleY)),
      };
    }).filter((region) => region.height >= 3 && region.textBottom > region.textTop);
  }

  function inspectCanvasTextLayout(canvas, PSM, options = {}) {
    const segmentation = chooseCanvasPageSegmentation(canvas, PSM);
    return {
      ...segmentation,
      lineRegions: getTextLineRegions(
        segmentation.analysis,
        canvas.width,
        canvas.height,
        options
      ),
    };
  }

  return {
    analyzeTextLines,
    chooseOcrPageSegmentation,
    chooseCanvasPageSegmentation,
    getTextLineRegions,
    inspectCanvasTextLayout,
  };
});
