# LightVoice

[English](README.md) · **Tiếng Việt**

**Dùng thử: https://lightvoice.jakeoss.workers.dev**

Chuyển văn bản tiếng Việt thành giọng nói, chạy hoàn toàn trong trình duyệt và
dùng được khi không có mạng: mô hình
[VieNeu-TTS v3 Nano](https://github.com/pnnbao97/VieNeu-TTS) (flow-matching
48 triệu tham số, Apache-2.0) chạy trên onnxruntime-web, cùng bộ chuẩn hoá và
chuyển chữ thành âm vị [sea-g2p](https://github.com/pnnbao97/sea-g2p) được
biên dịch sang WebAssembly.

Đọc văn bản tiếng Việt bằng 11 giọng có sẵn, hoặc tạo giọng của chính bạn từ
một đoạn ghi âm 5–10 giây. Sau lần mở đầu tiên (tải khoảng 190 MB), ứng dụng
chạy được khi không có mạng, và mọi thứ bạn gõ hay ghi âm đều không rời khỏi
thiết bị.

## Cài đặt

Cần Python 3.12 với [uv](https://docs.astral.sh/uv/), Node 20 trở lên, và Rust
có target `wasm32-unknown-unknown` (`rustup target add wasm32-unknown-unknown`).
Mô hình, runtime và bộ chuyển âm vị được build trên máy, không nằm trong repo.

```bash
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
npm install
.venv/bin/python scripts/prepare_assets.py   # mô hình -> web/models, dữ liệu kiểm thử -> tests/golden
npm run vendor                               # runtime onnxruntime-web -> web/vendor/ort
npm run build:g2p                            # sea-g2p -> web/g2p (cần Rust + target wasm32)
npm run manifest                             # kích thước file -> web/assets.json (trạng thái lưu trữ)
npm test                                     # so sánh code trình duyệt với bản Python gốc
npm run serve                                # http://localhost:8080
```

`serve` gửi kèm header COOP/COEP; thiếu chế độ cross-origin isolation thì
onnxruntime-web chỉ chạy WASM một luồng. Dịch vụ host tĩnh nào cũng dùng được,
miễn là gửi cùng các header đó.

## Triển khai

```bash
npm run build            # web/ -> dist/: tách file trên 20 MiB thành nhiều phần, ghi _headers
npx wrangler deploy      # Cloudflare Workers static assets (wrangler.jsonc), không cần Worker script
```

Cloudflare không nhận file lớn hơn 25 MiB, nên `scripts/build_dist.mjs` tách các
graph lớn và file WASM của onnxruntime thành các file `.partN`; worker tải từng
phần rồi lưu cache file đã ghép lại. Lệnh `node scripts/serve.mjs 8081 dist`
chạy bản build trên máy theo đúng cách đó.

## Thêm giọng đọc

```bash
.venv/bin/python scripts/add_voice.py clip.wav --name "Tên giọng" --description "Nam · Nam · ..."
uv pip install --python .venv/bin/python faster-whisper                 # cho eval_voice.py
.venv/bin/python scripts/eval_voice.py clip.wav --compare Adam   # độ giống + độ rõ
```

Mỗi giọng là một speaker embedding 192 chiều cộng với 50×256 style token, tính
từ một đoạn ghi âm 5–8 giây (một người nói, âm thanh sạch, tiếng Việt); không
cần huấn luyện. Giọng được lưu vào `voices/<slug>.json` và gộp vào
`web/models/nano.bin` (khoảng 50 KB mỗi giọng). Chỉ nhân bản giọng mà bạn có
quyền sử dụng.

`eval_voice.py` cho biết độ giống giữa giọng tạo ra và đoạn ghi âm (cùng một
người thường ≈ 0,75 trở lên) và tỉ lệ lỗi ký tự khi Whisper nhận dạng lại. Hãy
nghe cả các file WAV nó ghi vào `ref/eval/`.

## Nhân bản giọng trong trình duyệt

Người dùng có thể ghi âm hoặc tải lên một đoạn 5–10 giây để có giọng riêng. Giọng
được tạo ngay trên thiết bị và chỉ lưu trong trình duyệt đó
(`lightvoice-user-voices-v1` trong Cache Storage). Ba graph dùng để tạo giọng
(`web/models/clone/`, 48 MB với trọng số fp16) chỉ được tải ở lần nhân bản đầu
tiên. Trang web giải mã đoạn ghi âm ở 24 kHz và tạo thêm bản 16 kHz bằng
`OfflineAudioContext`; `web/js/clone.js` chuyển sang JavaScript các bước cắt
khoảng lặng, Kaldi fbank và `prepare_reference` (`tests/clone.test.mjs` kiểm tra
từng bước so với bản Python).

## Cấu trúc

| Thành phần | File | Bản gốc Python |
| --- | --- | --- |
| Bộ lấy mẫu flow + 4 graph ONNX | `web/js/engine.js` | `vieneu/v3nano.py` |
| Tách câu, chia đoạn, thẻ cảm xúc | `web/js/text.js` | `vieneu_utils/phonemize_text.py`, `core_utils.py` |
| Cắt/fade, nối đoạn, WAV | `web/js/audio.js` | `vieneu_utils/core_utils.py` |
| Chuẩn hoá + G2P | `web/g2p/` (WASM) | `sea_g2p` (cùng mã Rust) |
| Chạy suy luận ngoài luồng chính | `web/js/worker.js` | |
| Vỏ ứng dụng offline | `web/sw.js` | |

Worker giữ mô hình và từ điển trong Cache Storage (`MODEL_CACHE` trong
`web/js/config.js`), nên sau lần tải đầu không cần mạng nữa. Mỗi file được lưu
cache dưới dạng `path?v=<hash nội dung>` lấy từ `web/assets.json`
(`npm run manifest`). Vì vậy khi một file thay đổi (ví dụ thêm giọng chỉ đổi
`nano.json`/`nano.bin`), người dùng chỉ tải lại đúng file đó, và bản cũ bị xoá
sau lần tải thành công tiếp theo. Sau khi tải xong, trang xin quyền lưu trữ lâu
dài (`navigator.storage.persist()`) và cho biết file đã nằm trên thiết bị chưa,
cũng như trình duyệt có đồng ý giữ chúng hay không (`web/js/storage.js`).

Các graph phát hành lưu trọng số ở dạng fp16 nhưng tính toán ở fp32
(`scripts/fp16_weights.py`): dung lượng giảm một nửa, tốc độ giữ nguyên, không
cần kernel fp16. So với graph gốc, âm thanh chênh lệch ít hơn khoảng 100 lần so
với hai lần đọc cùng câu bằng hai seed khác nhau.

`npm run build:g2p` tải sea-g2p gốc ở một commit cố định vào `vendor/sea-g2p` và
áp dụng `vendor/sea-g2p-lightvoice.patch`: từ điển có thể nạp từ bộ nhớ thay vì
file mmap, và tính năng `wasm` xuất `SeaG2p` qua wasm-bindgen (`src/wasm.rs`).

## Hạn chế hiện tại

- Câu quá dài mà không có dấu câu sẽ được chia đều theo từ; bản Python còn tránh
  cắt ngang giữa một con số được đọc thành chữ.
- Nhân bản giọng trong trình duyệt chưa có bước khử nhiễu tuỳ chọn của VieNeu
  (43 MB), nên ghi âm ồn sẽ cho giọng ồn hơn. Luồng tải file lên đã được kiểm
  thử đầy đủ; luồng ghi âm bằng micro (MediaRecorder) chưa được thử trên thiết bị
  thật.
- Lần tải đầu khoảng 190 MB: 136 MB graph (trọng số fp16 gần như không nén được),
  15 MB từ điển đã gzip (chỉ tiếng Việt/tiếng Anh, 50 MB khi giải nén;
  `scripts/strip_dict.py`), 29 MB WASM của onnxruntime và 4 MB WASM của sea-g2p.
  WASM của onnxruntime được phát hành dưới dạng nhiều phần nên host không nén nó;
  nếu gzip sẽ còn khoảng 7 MB.
- Safari xoá dữ liệu do trang web lưu nếu bạn không truy cập trong 7 ngày, trừ khi
  ứng dụng được thêm vào màn hình chính; trang hiện chưa nhắc người dùng làm việc
  này.

## Lộ trình và đóng góp

Xem [`ROADMAP.md`](ROADMAP.md). Mỗi hạng mục là một issue có tiêu chí nghiệm thu
kiểm tra được bằng test. Các issue gắn nhãn `agent-ready` còn được một coding
agent chạy hằng đêm thực hiện và mở pull request để review ([`AGENTS.md`](AGENTS.md)
ghi các quy tắc, áp dụng cho cả người đóng góp). Các issue gắn nhãn
`needs-human`, như thử trên điện thoại thật hay nghe thử giọng đọc, là nơi bạn
giúp được nhiều nhất.

## Sử dụng có trách nhiệm

Chỉ nhân bản giọng mà bạn có quyền sử dụng; không bao giờ dùng để mạo danh, lừa
đảo hay đánh lừa người khác, và hãy cho biết đó là giọng tổng hợp khi người nghe
có lý do để muốn biết. Nguyên tắc này theo model card của VieNeu-TTS.

## Giấy phép

Apache-2.0, xem `LICENSE`. Trọng số mô hình, các giọng có sẵn và sea-g2p là tác
phẩm Apache-2.0 của Phạm Nguyễn Ngọc Bảo; ONNX Runtime Web dùng giấy phép MIT.
Xem `NOTICE` để biết phần ghi công và các thay đổi đã thực hiện, và
`THIRD_PARTY_NOTICES.md` để xem danh sách đầy đủ. Model card của VieNeu-TTS cho
phép dùng các giọng có sẵn và âm thanh tạo ra cho mục đích thương mại.
