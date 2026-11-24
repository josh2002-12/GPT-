function readPhotoQR(image, width, height) {
  const full = read(image, width, height);
  if (full) return full;
  // Preserve small codes on long receipts by scanning overlapping tiles.
  const side = Math.min(width, height, Math.max(700, Math.ceil(Math.max(width, height) / 5)));
  for (let y = 0; y < height; y += Math.ceil(side * .75)) {
    for (let x = 0; x < width; x += Math.ceil(side * .75)) {
      const row = decode(image, Math.min(x, width-side), Math.min(y, height-side), side, side);
      if (row) return row;
    }
  }
  return null;
}

function issueDate(text) {
  const pattern = /(?:^|[^\d])(20\d{2}|1\d{2}|09\d)\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})(?!\d|\s*月)/g;
  const labeled = text.split('\n').filter(line => /開立日期|發票日期|交易日期/.test(line.replace(/\s/g,'')));
  for (const line of [...labeled, ...text.split('\n')]) {
    if (/到期|有效期限|列印日期/.test(line)) continue;
    for (const match of line.matchAll(pattern)) {
      const [,year,month,day] = match;
      const date = [year.length === 3 ? Number(year)+1911 : year, month.padStart(2,'0'), day.padStart(2,'0')].join('-');
      const parsed = new Date(date+'T00:00:00Z');
      if (Number.isFinite(+parsed) && parsed.toISOString().startsWith(date)) return date;
    }
  }
  return '';
}

function labeledId(text, role) {
  const label = role === 'seller' ? '(?:賣方|銷售人|開立人|營業人)' : '(?:買方|買受人)';
  const idLabel = '(?:統一編號|統編|統一號碼)';
  const digits = '[:#﹕]?\\s*(\\d{4}[- ]?\\d{4})(?!\\d)';
  const compact = text.replace(/[^\S\n]+/g,'');
  const pattern = new RegExp(label+'\\s*(?:[（(]?'+idLabel+'[）)]?)?'+digits,'g');
  const matches = [...compact.matchAll(pattern)].map(m => m[1].replace(/\D/g,''));
  if (matches.length) return new Set(matches).size === 1 ? matches[0] : '';
  if (role === 'seller' && !/買方|買受人/.test(compact)) {
    const standalone = [...compact.matchAll(new RegExp('^'+idLabel+digits+'(?=$|[^0-9])','gm'))];
    if (standalone.length === 1) return standalone[0][1].replace(/\D/g,'');
  }
  return '';
}

function extractFields(text) {
  const lines = text.normalize('NFKC').toUpperCase().split(/\r?\n/).map(line => line.replace(/\s/g, ''));
  const joined = lines.join('\n');
  const number = joined.match(/(?:^|[^A-Z0-9])([A-Z]{2})[-–—]?(\d{8})(?!\d)/);
  const normalized = text.normalize('NFKC').replace(/[‐‑–—−]/g,'-');
  const date = issueDate(normalized);
  const total = joined.match(/(?:總計|總金額|應付金額|含稅合計|GRANDTOTAL|^TOTAL)[:：]?(?:NT\$?|新臺幣|新台幣|TWD|\$)?([\d,]+)(?:\.00)?(?:元|圓)?$/m);
  return [number ? number[1]+number[2] : '', date, total ? total[1].replace(/,/g,'') : '', labeledId(normalized,'seller'), labeledId(normalized,'buyer')];
}

// Restore reading order when OCR splits the printed label across text blocks.
function sellerFromWords(words) {
  const found = new Set();
  for (const candidate of words) {
    const digits = candidate.text.normalize('NFKC').trim();
    if (!/^\d{8}$/.test(digits)) continue;
    const box = candidate.bbox;
    const h = box.y1 - box.y0;
    const center = (box.y0 + box.y1) / 2;
    const left = words.filter(word => {
      const b = word.bbox;
      return b.x1 <= box.x0 + 1 && box.x0 - b.x1 < 6 * h &&
        Math.abs((b.y0 + b.y1) / 2 - center) <= 0.65 * h;
    }).sort((a,b) => a.bbox.x0-b.bbox.x0);
    const label = left.map(word => word.text).join('').normalize('NFKC').replace(/\s/g,'');
    if (/(?:賣方|銷售人|開立人)(?:統一編號|統編)?[:﹕]?$/.test(label)) found.add(digits);
  }
  return found.size === 1 ? [...found][0] : '';
}

async function recognizePhoto(image, width, height, id) {
  const surface = document.createElement('canvas');
  const scale = Math.min(1, 3000 / Math.max(width, height));
  surface.width = Math.max(1, Math.round(width*scale));
  surface.height = Math.max(1, Math.round(height*scale));
  surface.getContext('2d').drawImage(image, 0, 0, surface.width, surface.height);
  const path = name => new URL('ocr/'+name, document.baseURI).href;
  const worker = await Tesseract.createWorker('chi_tra+eng', 1, {
    workerPath: path('worker.min.js'), corePath: path('core.js'), langPath: path(''),
    workerBlobURL: false,
    logger: update => {
      if (run === id && update.status === 'recognizing text') msg('正在辨識發票文字 '+Math.round(update.progress*100)+'%');
    }
  });
  try {
    if (run !== id) return;
    const {data} = await worker.recognize(surface);
    if (run !== id) return;
    const row = extractFields(data.text);
    if (!row[1] || !row[3]) {
      await worker.setParameters({tessedit_pageseg_mode: '11'});
      const retry = await worker.recognize(surface);
      if (run !== id) return;
      const recovered = extractFields(retry.data.text);
      for (const i of [1, 3]) if (!row[i]) row[i] = recovered[i];
    }
    if (!row[3]) {
      await worker.setParameters({tessedit_pageseg_mode: '3'});
      const {data: layout} = await worker.recognize(surface);
      if (run !== id) return;
      row[3] = labeledId(layout.text.normalize('NFKC'), 'seller') || sellerFromWords(layout.words || []);
    }
    show(row);
    msg(row.some(Boolean) ? '文字辨識完成，請對照原發票確認每個欄位。' : '讀不到清楚的欄位，請對照原發票填寫，或重拍近一點。');
  } finally {
    await worker.terminate();
  }
}
