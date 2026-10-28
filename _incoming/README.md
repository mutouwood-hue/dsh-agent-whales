# _incoming —— 生成图投放处

把 AI 生成的**白底 PNG** 丢进这个目录，**文件名就是精灵 key**：

    q-laugh.png      q-surprise.png    q-pout.png
    q-shy.png        q-think.png       q-sleep.png

然后跑：

    python tools/ingest-generated.py _incoming
    node tools/embed-art.mjs
    node --test test/client.test.mjs

提示词与交图规格见 `tools/PROMPTS-generated.md`。