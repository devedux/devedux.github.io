---
title: "Semana 3: Attention, la pieza que le da contexto real a un modelo"
description: "Tercer paso de frontend a AI engineer: cómo un modelo decide a qué palabras anteriores prestarle atención, y por qué necesita una máscara para no hacer trampa."
pubDate: 2026-07-29
tags: ["ai-engineering", "transformers", "attention"]
draft: false
---

El problema que tuvimos en la Semana 2 es que nuestra red solo podía mirar un token hacia atrás del contexto, y esto era porque decidimos ponerle un block_size de 1. La red funcionaba, pero no tenía la capacidad de usar más contexto para ir prediciendo mejor (por ejemplo, para saber si un verbo va en singular o plural según un sujeto varias palabras atrás).

Es por eso que entra **Attention**: le da a cada token la capacidad de ver todos los tokens anteriores y ponerles un peso a cada uno de ellos.

## Attention no reemplaza a block_size, lo complementa

Cuando armábamos el dataset en la Semana 2 (contexto → siguiente token), `block_size` era el que decidía cuántos tokens de contexto le dábamos al modelo. Ese `block_size` sigue existiendo dentro de Attention (ahí es `T`), no desaparece. Lo que cambia es cómo se usa ese contexto: antes, con `block_size=1`, solo podíamos usar 1 token porque no había forma de decidir qué pesarle a más de uno. Con Attention podemos usar un `block_size` mucho más grande, porque ahora el modelo aprende a pesar cada uno de esos tokens según qué tan relevante sea, en vez de usarlos a ciegas o descartarlos.

## La analogía: una reunión

Cada token es como una persona en una reunión. Cada uno:

- Levanta un cartel con lo que busca (su **query**).
- Lleva una etiqueta con lo que ofrece (su **key**).
- Tiene información real que comparte si alguien le presta atención (su **value**).

Cada persona compara su cartel contra la etiqueta de las demás, y a quienes calzan mejor les presta más atención, tomando más de su value.

## El código: Q, K, V

Tres capas lineales, cada una proyecta el embedding (`C=32` números) a un espacio más chico (`head_size=16`):

```python
key   = nn.Linear(C, head_size, bias=False)
query = nn.Linear(C, head_size, bias=False)
value = nn.Linear(C, head_size, bias=False)

k = key(x)
q = query(x)
v = value(x)
```

Con `x` de forma `(1, 8, 32)` (1 oración, 8 tokens, 32 números por token), `k`, `q` y `v` salen en `(1, 8, 16)`.

## Attention scores y por qué hay que escalar

Comparar cada query contra cada key es una multiplicación de matrices:

```python
wei = q @ k.transpose(-2, -1)
```

El resultado es `(1, 8, 8)`: para cada token, qué tanto calza con cada uno de los otros 8 (incluido él mismo). Estos números crudos se llaman **attention scores**.

Dentro de Attention, si no manejamos bien el tema del `head_size`, podríamos sobrecargar el softmax cuando llegue el momento de aplicarlo. Es por eso que usamos el escalado: una operación para evitar justamente eso, usando `head_size` (un hiperparámetro, decisión nuestra, no algo que la red aprende) para obtener la constante por la que se divide cada score. Ese `head_size` es el mismo para todos los tokens, no uno distinto por cada uno.

```python
wei = wei * head_size**-0.5
```

Esto es lo que le da el nombre completo al mecanismo: **Scaled Dot-Product Attention**.

## Softmax y attention weights

```python
wei = wei.softmax(dim=-1)
```

`dim=-1` es el eje de tamaño `T` (los 8 tokens): las opciones entre las que cada token reparte su 100% de atención. Recién después de este softmax, esos números dejan de ser "scores" y pasan a llamarse **attention weights**.

## El problema de hacer trampa

Con la matriz `wei` de `(8, 8)` completa, el token en la posición 0 podría prestarle atención al token en la posición 7, uno que todavía no "existe" en el momento de generar texto letra por letra. Eso es trampa: al predecir la siguiente letra, el modelo no puede espiar letras futuras.

La solución es una **máscara causal** (o *triangular mask*): cada fila `i` solo puede ver las columnas `0` a `i`, nunca las de después. En la matriz esto dibuja un triángulo (diagonal hacia abajo permitido, arriba bloqueado). Se construye con `torch.tril` y se aplica reemplazando las posiciones bloqueadas con `-inf` antes del softmax, para que `exp(-inf) = 0` garantice 0% de atención ahí.

Esta es la pieza que convierte self-attention genérico (útil para entender un texto completo de una) en algo apto para generar texto letra por letra.

## Empaquetando todo en una clase Head

Todo lo anterior (Q, K, V, escalado, máscara, softmax, mezcla con V) lo envolví en una clase `Head(nn.Module)`, para poder reutilizarla. El `tril` de la máscara se guarda una sola vez con `self.register_buffer(...)` en vez de recrearse en cada `forward` (un buffer es como un peso, pero que no se entrena):

```python
class Head(nn.Module):
    def __init__(self, C, head_size, block_size):
        super().__init__()
        self.head_size = head_size
        self.key   = nn.Linear(C, head_size, bias=False)
        self.query = nn.Linear(C, head_size, bias=False)
        self.value = nn.Linear(C, head_size, bias=False)
        self.register_buffer('tril', torch.tril(torch.ones(block_size, block_size)))

    def forward(self, x):
        B, T, C = x.shape
        k = self.key(x)
        q = self.query(x)
        v = self.value(x)
        wei = q @ k.transpose(-2, -1) * self.head_size**-0.5
        wei = wei.masked_fill(self.tril[:T, :T] == 0, float('-inf'))
        wei = wei.softmax(dim=-1)
        return wei @ v
```

## Multi-head attention: varias perspectivas en paralelo

Head ya paraleliza los tokens (todos los 8 a la vez, en una sola operación de matrices), pero con un solo `head_size` y una sola forma de comparar. MultiHeadAttention corre varias cabezas **independientes** en paralelo, todas con el mismo `head_size`, pero cada una con sus propios pesos aprendidos por separado, cada una fijándose en un tipo distinto de relación entre tokens. No es paralelizar la misma cabeza, es paralelizar perspectivas distintas sobre los mismos tokens.

```python
class MultiHeadAttention(nn.Module):
    def __init__(self, num_heads, C, head_size, block_size):
        super().__init__()
        self.heads = nn.ModuleList([Head(C, head_size, block_size) for _ in range(num_heads)])
        self.proj = nn.Linear(head_size * num_heads, C)

    def forward(self, x):
        out = torch.cat([h(x) for h in self.heads], dim=-1)
        return self.proj(out)
```

Con 4 cabezas de `head_size=8` (`4×8=32=C`), cada `Head` da `(1,8,8)`, la concatenación en `dim=-1` da `(1,8,32)`, y la proyección final mezcla las 4 perspectivas en una sola salida de `(1,8,32)`.

## En qué me confundí

- Confundí `head_size` con `block_size`: pensé que escalar el softmax tenía que ver con "darle mucho contexto" (más tokens), pero en realidad depende del tamaño de los vectores query/key/value, no de cuántos tokens hay.
- Invertí la causalidad: pensé que attention existía *para* evitar que el softmax colapsara. En realidad attention existe para resolver "a quién le hago caso"; el escalado es un ajuste técnico aparte, dentro de attention, para un problema numérico puntual.
- Dije "dividir cada peso" cuando en realidad se divide el **score** (antes del softmax); recién después de softmax esos números se llaman "peso" (weight).
- Pensé que la máscara causal bloqueaba filas enteras. En realidad bloquea celdas específicas dentro de cada fila, y cuáles celdas bloquear depende de la posición de esa fila (de ahí la forma triangular).
- Pensé que Attention "reemplazaba" a block_size. En realidad block_size (T) sigue ahí, del mismo tamaño; lo que cambia es que ahora el modelo puede pesar cada token de ese contexto en vez de usarlo a ciegas.
- Dije que multi-head era "paralelizar este head", como si fueran copias de la misma cabeza. Son cabezas independientes, con el mismo head_size pero pesos aprendidos distintos cada una.

## FeedForward: un momento para pensar solo

Attention deja que cada token escuche a los demás y arme una mezcla ponderada de su información. Pero eso es solo comparar y mezclar, no hay ningún procesamiento adicional sobre esa información ya reunida. FeedForward es exactamente eso: después de escuchar a los demás en la reunión, cada token se toma un momento para procesar por su cuenta lo que escuchó, sin mirar a nadie más. Es un MLP normal, aplicado a cada token de forma independiente.

La convención del paper original: se expande la dimensión 4 veces y se vuelve a comprimir, `C → 4*C → C`, con ReLU en medio (`ReLU(x) = max(0, x)`: los negativos se vuelven 0, los positivos pasan igual).

```python
class FeedForward(nn.Module):
    def __init__(self, C):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(C, 4*C),
            nn.ReLU(),
            nn.Linear(4*C, C),
        )

    def forward(self, x):
        return self.net(x)
```

## Residual connections y Layer Norm

Si encadenas attention y feedforward directo (`x = feedforward(attention(x))`), cada capa reemplaza por completo la salida de la anterior. En una red con muchas capas apiladas, el gradiente tiene que atravesar todas esas transformaciones en el backward pass y se puede desvanecer, el mismo problema de gradientes inestables que ya vi en Semana 2, pero ahora por profundidad.

La solución es sumar en vez de reemplazar: `x = x + attention(x)`. Por la regla de la cadena, la derivada de una suma se reparte igual a ambos lados, así que el gradiente siempre tiene un camino directo hacia atrás a través del `+`. Es como escribir con control de cambios: no reescribes el original, le agregas una nota encima y el original sigue intacto debajo.

Layer Norm complementa esto: para cada token, normaliza sus `C` números a media 0 y desviación estándar 1, y después aplica una escala/desplazamiento aprendido. Es otra herramienta contra el mismo problema de gradientes inestables en redes profundas. PyTorch ya la trae con `nn.LayerNorm(C)`.

## El bloque Transformer completo

Uniendo todo (self-attention, feedforward, residual connections, layer norm) en una sola clase reutilizable, que se puede apilar varias veces:

```python
class Block(nn.Module):
    def __init__(self, C, num_heads, block_size):
        super().__init__()
        head_size = C // num_heads
        self.sa = MultiHeadAttention(num_heads, C, head_size, block_size)
        self.ffwd = FeedForward(C)
        self.ln1 = nn.LayerNorm(C)
        self.ln2 = nn.LayerNorm(C)

    def forward(self, x):
        x = x + self.sa(self.ln1(x))
        x = x + self.ffwd(self.ln2(x))
        return x
```

Aquí encontré un bug real: había escrito `head_size = C` en vez de `head_size = C // num_heads`. Corría igual (las formas cuadraban porque la proyección final se adapta), pero cada cabeza terminaba usando el ancho completo en vez de repartir `C` entre las `num_heads` cabezas, perdiendo la idea de dividir el trabajo entre perspectivas.

## Positional embeddings: saber en qué posición estás

Mi tabla de embeddings de Semana 2 le daba a cada token un vector según quién es. Pero attention necesita algo más: en qué posición está, porque comparar tokens con `q @ k.T` no distingue si un token va primero o al final (la máscara causal solo bloquea el futuro, no comunica la posición exacta).

La solución es una segunda tabla de embeddings, indexada por posición en vez de por token, del mismo tamaño `C`, y se suman ambas: `x = token_embedding + position_embedding`. Cada token queda representado por quién es más dónde está.

```python
self.token_embedding_table = nn.Embedding(vocab_size, C)
self.position_embedding_table = nn.Embedding(block_size, C)
```

## GPTLanguageModel: todo ensamblado

```python
class GPTLanguageModel(nn.Module):
    def __init__(self, vocab_size, C, num_heads, num_layers, block_size):
        super().__init__()
        self.token_embedding_table = nn.Embedding(vocab_size, C)
        self.position_embedding_table = nn.Embedding(block_size, C)
        self.blocks = nn.Sequential(*[Block(C, num_heads, block_size) for _ in range(num_layers)])
        self.ln_f = nn.LayerNorm(C)
        self.lm_head = nn.Linear(C, vocab_size)

    def forward(self, idx, targets=None):
        B, T = idx.shape
        tok_emb = self.token_embedding_table(idx)
        pos_emb = self.position_embedding_table(torch.arange(T))
        x = tok_emb + pos_emb
        x = self.blocks(x)
        x = self.ln_f(x)
        logits = self.lm_head(x)

        if targets is None:
            loss = None
        else:
            B, T, vocab_size = logits.shape
            logits = logits.view(B*T, vocab_size)
            targets = targets.view(B*T)
            loss = F.cross_entropy(logits, targets)

        return logits, loss

    def generate(self, idx, max_new_tokens, block_size):
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -block_size:]
            logits, loss = self(idx_cond)
            logits = logits[:, -1, :]
            probs = F.softmax(logits, dim=-1)
            idx_next = torch.multinomial(probs, num_samples=1)
            idx = torch.cat((idx, idx_next), dim=1)
        return idx
```

Antes de entrenar, probé con pesos sin entrenar y `vocab_size=27` de prueba: el loss salió en `3.39`, muy cerca del `-log(1/27) ≈ 3.296` esperado para un modelo que reparte probabilidad al azar entre 27 opciones. Esa cercanía confirmó que toda la arquitectura estaba bien conectada, sin bugs escondidos, antes de gastar tiempo entrenando.

## Entrenamiento real y un hallazgo honesto: overfitting

Para entrenar, reusé el dataset de Semana 2 (emma, olivia, ava, isabella, sophia), pero en vez de ejemplos de 1 letra de contexto, uní todo en un solo texto continuo (`.emma.olivia.ava.isabella.sophia.`) y armé una función que toma ventanas aleatorias de `block_size` letras:

```python
def get_batch(batch_size, block_size):
    ix = torch.randint(len(data) - block_size, (batch_size,))
    x = torch.stack([data[i:i+block_size] for i in ix])
    y = torch.stack([data[i+1:i+block_size+1] for i in ix])
    return x, y
```

El truco elegante: `y` es `x` corrido una posición, así que una sola ventana de `block_size` letras da `block_size` pares de entrenamiento gratis (gracias a la máscara causal), cada uno con un contexto de largo distinto, desde 1 letra hasta `block_size` letras.

Para el entrenamiento usé `torch.optim.Adam`, que reemplaza el `C.data += -0.1 * C.grad` que escribía a mano en Semana 2, pero para todos los pesos del modelo a la vez:

```python
optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)

for step in range(3000):
    xb, yb = get_batch(batch_size=16, block_size=8)
    logits, loss = model(xb, yb)
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    optimizer.step()
```

El loss bajó de `2.77` a `~0.13`, mucho más bajo que el `1.33` final de Semana 2. Pero al generar, el modelo escupió literalmente mi corpus de entrenamiento: `.emma.olivia.ava.isabella.sophia.a.ava.is...`, no nombres nuevos.

Eso no es un bug, es **overfitting**: con `block_size=8` (casi el nombre completo de contexto) y un corpus de solo 33 caracteres repetido 3000 veces, el modelo tuvo de sobra para memorizar la secuencia exacta en vez de aprender un patrón generalizable. En Semana 2, con solo 1 letra de contexto, había ambigüedad real que forzaba al modelo a generalizar; acá, con tanto contexto y tan poco dataset, memorizar fue más fácil que generalizar. Es un fenómeno real de ML, no un defecto de la implementación, y algo que voy a volver a ver en la Fase 2 del roadmap (Evals).

## En qué me confundí

- Confundí `head_size` con `block_size`: pensé que escalar el softmax tenía que ver con "darle mucho contexto" (más tokens), pero en realidad depende del tamaño de los vectores query/key/value, no de cuántos tokens hay.
- Invertí la causalidad: pensé que attention existía *para* evitar que el softmax colapsara. En realidad attention existe para resolver "a quién le hago caso"; el escalado es un ajuste técnico aparte, dentro de attention, para un problema numérico puntual.
- Dije "dividir cada peso" cuando en realidad se divide el **score** (antes del softmax); recién después de softmax esos números se llaman "peso" (weight).
- Pensé que la máscara causal bloqueaba filas enteras. En realidad bloquea celdas específicas dentro de cada fila, y cuáles celdas bloquear depende de la posición de esa fila (de ahí la forma triangular).
- Pensé que Attention "reemplazaba" a block_size. En realidad block_size (T) sigue ahí, del mismo tamaño; lo que cambia es que ahora el modelo puede pesar cada token de ese contexto en vez de usarlo a ciegas.
- Dije que multi-head era "paralelizar este head", como si fueran copias de la misma cabeza. Son cabezas independientes, con el mismo head_size pero pesos aprendidos distintos cada una.
- En `Block`, escribí `head_size = C` en vez de `C // num_heads` (bug real, no solo confusión conceptual: corría sin error pero rompía la idea de repartir el ancho entre cabezas).
- En `GPTLanguageModel.forward`, usé las tablas de embeddings globales de prueba en vez de `self.token_embedding_table` / `self.position_embedding_table`. Otro bug silencioso: los pesos del modelo nunca se habrían entrenado, porque `forward` no los estaba usando.

## Qué sigue

El entregable de la semana quedó completo: un GPT mini a nivel de carácter, con self-attention implementada a mano, entrenado y generando texto (aunque memorizado, por el tamaño del dataset). Todavía me falta ver tokenización BPE a nivel conceptual (cómo tokeniza un modelo real, más allá de carácter por carácter). Para la Semana 4: sampling, KV cache, por qué alucinan los modelos, y la diferencia entre pretraining y SFT/RLHF.
