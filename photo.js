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

function extractFields(text) {
  const lines = text.normalize('NFKC').toUpperCase().split(/\r?\n/).map(line => line.replace(/\s/g, ''));
  const joined = lines.join('\n');
  const number = joined.match(/(?:^|[^A-Z0-9])([A-Z]{2})[-–—]?(\d{8})(?!\d)/);
  const dateParts = joined.match(/(?:^|[^\d])(\d{3}|20\d{2})[-./年](\d{1,2})[-./月](\d{1,2})(?!\d)/);
  let date = '';
  if (dateParts) {
    const [,year,month,day] = dateParts;
    const value = [year.length === 3 ? +year+1911 : year, month.padStart(2,'0'), day.padStart(2,'0')].join('-');
    const parsed = new Date(value+'T00:00:00Z');
    if (Number.isFinite(+parsed) && parsed.toISOString().startsWith(value)) date = value;
  }
  const total = joined.match(/(?:總計|總金額|應付金額|含稅合計|GRANDTOTAL|^TOTAL)[:：]?(?:NT\$?|新臺幣|新台幣|TWD|\$)?([\d,]+)(?:\.00)?(?:元|圓)?$/m);
  const seller = joined.match(/(?:賣方|銷售人)(?:統一編號|統編)?[:：]?(\d{8})(?!\d)/);
  const buyer = joined.match(/(?:買方|買受人)(?:統一編號|統編)?[:：]?(\d{8})(?!\d)/);
  return [number ? number[1]+number[2] : '', date, total ? total[1].replace(/,/g,'') : '', seller?.[1] || '', buyer?.[1] || ''];
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
    show(row);
    msg(row.some(Boolean) ? '文字辨識完成，請對照原發票確認每個欄位。' : '讀不到清楚的欄位，請對照原發票填寫，或重拍近一點。');
  } finally {
    await worker.terminate();
  }
}
