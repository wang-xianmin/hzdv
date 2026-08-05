# Catalog → Vectorize（试跑）

## 前置

1. 已创建索引（768 / cosine），例如：
   `npx wrangler vectorize create hzdv-index --dimensions=768 --metric=cosine`
2. Cloudflare Pages 项目绑定：
   - **Workers AI** → 变量名 `AI`
   - **Vectorize** `hzdv-index` → 变量名 `VECTORIZE`（或 `HZDV_INDEX`）
3. D1 中已有 `catalog_items`（product / solution）

Embedding 固定：`@cf/google/embeddinggemma-300m`（768 维）。

## 使用

系统运维 → 产品目录：

- **重建向量索引**：把启用中的 product + solution 写入 Vectorize；停用条目会尝试删除对应向量
- **试搜**：输入自然语言，看 top 命中

API：`POST /api/catalog-index`（需目录运维权限）

```json
{ "phone": "…", "action": "reindex" }
{ "phone": "…", "action": "query", "q": "耐腐蚀阀门", "topK": 5 }
```

向量 id：`catalog:<item_id>`；metadata 含 `source=catalog`、`kind`、`name`、`model`。
