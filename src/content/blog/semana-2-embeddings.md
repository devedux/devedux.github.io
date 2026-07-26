---
title: "Semana 2: embeddings — cómo una red entiende letras"
description: "Segundo paso de frontend a AI engineer: cómo se representan letras y palabras como números para que una red pueda trabajar con lenguaje."
pubDate: 2026-07-24
tags: ["ai-engineering", "embeddings"]
draft: false
---

Una red neuronal solo entiende números. Entonces, ¿cómo le das **letras**? ¿Cómo le enseñas lenguaje a algo que solo sabe de matemáticas? Esa fue la pregunta que resolví esta semana.

## El problema: una red solo entiende números

Para entrenar una red solo es posible con números, o sea que si queremos pasarle letras no lo soportaría. Entonces, ¿cómo hacemos para que las letras o todo nuestro vocabulario se soporte en la red? Lo que tenemos que hacer es transformarlos en números, pero no hay que caer en la trampa de asignarle un número a cada letra (a=1, b=2, ..., z=26), porque la red podría confundirse y tratarlo como si `z` fuera mayor que `a`, y así sucesivamente, o que `c` va entre `a` y `z`. Cosa que está mal.


## Los conceptos, con las analogías que me ayudaron

Entonces ahí viene el concepto de embeddings, que transforma cada token (letra, fragmento, palabra) en vectores (coordenadas) que van tomando una posición de acuerdo a su coordenada en el diagrama vectorial. La magia de esto es que al inicio pueden tomar valores aleatorios, pero cuando pasa por el bucle de entrenamiento los tokens pueden quedar juntos o separados según cómo se vaya entrenando en la red; los tokens similares que se usan en contextos parecidos quedan juntos.

### El dataset: contexto → siguiente token

Para entrenar a nuestra red, le enviamos un dataset de ejemplos, donde cada ejemplo vendría a ser (context → next token), teniendo en cuenta que nosotros decidimos cuánto de contexto le daremos; a esto se le llama block_size, y podemos darle entre 1 a más tokens anteriores. Y el next token también depende de nosotros: la unidad que le demos a nuestro token, ya sea letra, fragmento, palabra, etc.

Entonces, una vez que ya sabemos cómo se conforma nuestro dataset, esto se le da a nuestra red para que prediga el siguiente token. Es recomendable darle muchos ejemplos, así nuestra red ya no memoriza sino que descubre patrones, por ejemplo: después de una vocal viene la consonante.

### Softmax: de números crudos a probabilidades

El resultado del forward pass son números crudos, y esto no nos sirve para predecir probabilidades. Es por eso que usamos el método **softmax** para convertir esos números crudos a probabilidades, siguiendo 2 pasos.

Primero, usamos la **función exponencial** para convertir cada número a positivo; esto hace que destaquen los números grandes. Segundo, sumamos todos los números y **dividimos cada número entre esa suma total**, lo que hace que todo sume 1. Entonces podríamos deducir que 1 = 100% y cada número es un % de probabilidad. Y es así como obtenemos las probabilidades de cada número.

### Cross-entropy: medir qué tan buena fue la predicción

Hasta ahí todo bien, pero hay otro problema: no sabemos si la probabilidad que le dio a cada token es correcta. Por ejemplo, pudo haberle dado 90% a un token incorrecto. Dicho eso, usamos **cross-entropy**: este toma solo la probabilidad de la **respuesta correcta** (el target) y usa el **logaritmo negativo** para obtener el loss; o sea, castiga cuando le da poca probabilidad a la respuesta correcta.

¿Por qué logaritmo negativo? Porque el logaritmo de un valor entre 0 y 1 da negativo, y al agregarle el negativo lo volvemos positivo. Así, si le dio alta probabilidad a la correcta, el loss es bajo; si le dio poca, el loss es alto.

Al obtener el loss, podemos proseguir con el flujo de entrenamiento que ya conocemos: zero-grad, backward pass y update. Cross-entropy solo reemplaza al MSE de la Semana 1; todo lo demás del entrenamiento es idéntico.


## En qué me confundí

- Creí que había un dataset por palabra pero en realidad solo es un solo dataset de ejemplos de todas las palabras juntas.
- Confundí "ejemplo = palabra", pero no, una palabra genera VARIOS ejemplos. 

### El learning rate y los exploding gradients

Al entrenar, puse un learning rate muy alto y el loss, en vez de bajar, empezó a subir hasta explotar en `nan`. Eso se llama exploding gradients. Aprendí que el learning rate es delicado, ya que puede afectar el entrenamiento de nuestra red. ¿Cómo encontrar un buen learning rate? Pues simplemente probando y observando cómo se comporta el entrenamiento; si explota, tenemos que ajustar, mover, cambiar valores.


## El código: construyendo embeddings paso a paso

En la Semana 1 construí backprop a mano con mi clase `Value`. Esta semana di el salto a **PyTorch**, que hace exactamente lo mismo (forward, backward, gradientes) pero de forma eficiente: en vez de un número por nodo, trabaja con **tensores** (matrices de muchos números de golpe). Como ya sabía qué hacía por dentro, no fue una caja negra.

### Los pesos

Creo la tabla de embeddings y los pesos de la capa. El `requires_grad=True` le dice a PyTorch "esto es un peso, calcula su gradiente", igual que mis `Value` acumulaban `.grad`.

```python
C = torch.randn(vocab_size, embedding_dim, requires_grad=True)  # tabla de embeddings
W = torch.randn(embedding_dim, vocab_size, requires_grad=True)  # pesos de la capa
b = torch.randn(vocab_size, requires_grad=True)                 # bias
```

Y lo mejor: indexar la tabla sigue igual que antes, pero de golpe:

```python
emb = C[X]   # busca los embeddings de los 32 ejemplos de una sola vez
```

### El forward: de embeddings a logits

```python
logits = emb @ W + b
```

El `@` es la multiplicación de matrices (el `w*x` de la Semana 1, pero para toda la matriz a la vez). El resultado son los **logits**: los números crudos, uno por token posible.

### Softmax + cross-entropy

Convertir los logits en probabilidades, y medir el error:

```python
counts = logits.exp()                            # exp (todo positivo)
probs = counts / counts.sum(1, keepdim=True)     # normalizar (÷ la suma)
loss = -probs[torch.arange(32), Y].log().mean()  # cross-entropy
```

El truco es `probs[torch.arange(32), Y]`: para cada ejemplo, toma la probabilidad de la letra **correcta** (la que está en `Y`). Eso es cross-entropy: `-log` de la probabilidad de la correcta.

### El bucle de entrenamiento

Y aquí está lo bonito: es exactamente el mismo flujo de la Semana 1.

```python
for k in range(1000):
    # forward
    emb = C[X]
    logits = emb @ W + b
    probs = logits.exp() / logits.exp().sum(1, keepdim=True)
    loss = -probs[torch.arange(32), Y].log().mean()

    # zero grad
    C.grad = None; W.grad = None; b.grad = None

    # backward
    loss.backward()

    # update
    C.data += -0.1 * C.grad
    W.data += -0.1 * W.grad
    b.data += -0.1 * b.grad
```

Reconocí cada parte: zero-grad → backward → update. Cross-entropy solo reemplazó al MSE; todo lo demás fue idéntico.

### Generar nombres (inferencia)

Con la red entrenada, generar es **inferencia**: forward sin backward, token por token.

```python
ix = stoi['.']
while True:
    emb = C[torch.tensor([ix])]
    logits = emb @ W + b
    probs = logits.exp() / logits.exp().sum(1, keepdim=True)
    ix = torch.multinomial(probs, 1).item()   # sampling
    if ix == stoi['.']: break
    salida.append(itos[ix])
```

`torch.multinomial` elige la siguiente letra al azar, pesada por las probabilidades (**sampling**), y cada letra generada alimenta a la siguiente (**autoregresión**).

El código completo está en [mi repo](https://github.com/devedux/ai-engineering-journey/tree/main/semana-02-embeddings).


## El resultado

Entrené con 5 nombres (emma, olivia, ava, isabella, sophia) y el loss bajó de **3.14 a 1.33** en 1000 vueltas. No llegó tan abajo como el 0.038 de la Semana 1, y está bien: la tarea es más difícil (predecir 1 de 12 letras, con ambigüedad real) y el modelo es diminuto (mira solo 1 letra atrás).

Después usé el modelo para **generar nombres** nuevos:

```
ia
msola
a
aviia
sa
```

Los nombres generados son palabras a medias, no son nombres reales, pero no son ruido: alternan vocales y consonantes, `aviia` se parece a "olivia"/"ava", y todos terminan solos (el modelo aprendió cuándo poner el `.`). Es la misma idea que hay detrás de Claude o GPT (predecir el siguiente token y muestrear), en versión diminuta.

### Los embeddings, hechos visibles

Como cada embedding es 2D, pude graficar las letras en un plano. Lo mágico: **estas posiciones no las puse yo, las aprendió backprop**.

![Embeddings 2D de las letras, aprendidos por la red](/embeddings-semana2.png)

Con solo 5 nombres la separación no es nítida, pero las letras no quedaron amontonadas al azar: hay agrupamientos (algunas consonantes juntas, el `.` aparte por su rol único). Empezaron en posiciones aleatorias y el entrenamiento las reubicó según cómo se usan. Con los 32.000 nombres del makemore real, las vocales se agruparían de forma clara, pero el mecanismo es idéntico al que acabo de ver.


## Qué me llevo y qué sigue

Lo que me llevo de esta semana: entender los **embeddings** (cómo una red representa letras) y cómo **softmax + cross-entropy** encajan en el mismo bucle de entrenamiento que ya conocía. Lo mejor fue darme cuenta de que no era empezar de cero, el backward, el update, el bucle ya los tenía de la Semana 1; solo cambió cómo entra el lenguaje y cómo se mide el error.

Para la Semana 3 estoy emocionado, toca construir un **transformer** (la arquitectura real detrás de Claude y GPT) con el mecanismo de atención. Sigo aprendiendo.
