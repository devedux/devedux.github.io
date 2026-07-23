---
title: "Semana 1: cómo entendí backpropagation desde cero"
description: "Mi primer paso convirtiéndome de frontend engineer a AI engineer: construir un motor de autograd a mano y entender de verdad cómo aprende una red neuronal."
pubDate: 2026-07-23
tags: ["ai-engineering", "backprop"]
draft: false
---

No quería simplemente usar un modelo como Claude, Deepseek, Gemini y meterle de lleno GraphRAG, embeddings y Harness Agentics. Porque actualmente esto la IA ya te lo puede construir, pero me topé con el techo: no sabía qué se necesita de verdad para llevar IA a producción con buenas prácticas, cómo construir un buen agente o una orquestación multi-agente. Así que decidí aprender desde cero.

## Qué es backprop y por qué me importaba entenderlo
Backpropagation es el algoritmo que calcula los gradientes durante el entrenamiento de una red neuronal, es el que nos dice "hacia dónde y cuánto ajustar cada peso". Es el corazón de cómo aprende cualquier red, desde un micrograd de juguete hasta un LLM como Claude o GPT.

**¿Por qué me importaba entenderlo?** Porque sin esto, todo lo demás (transformers, fine-tuning, RAG) es una caja negra. Entender backprop es entender qué pasa por dentro cuando una red "aprende": las operaciones, cómo fluye la información hacia adelante y el gradiente hacia atrás, deja de ser magia.


## El flujo de entrenamiento
Para lograr entrenar una red, se sigue un flujo básico que se repite hasta lograr que nuestra red pueda predecir correctamente. Este flujo se llama bucle de entrenamiento.

El bucle de entrenamiento está conformado por estos conceptos:
- **Forward pass:** Es el algoritmo que nos ayuda a obtener el loss value, internamente se usa un proceso de activación que nos ayuda a transformar los valores grandes a -1..1, esto con el fin de que nuestra red pueda aprender no solo de líneas rectas sino de curvas más complejas. Una de las activaciones que aprendí fue tanh, el tanh se ejecuta por cada neurona.
- **Loss:** Luego de obtener el loss, si su valor es elevado nos indica que tiene errores en su predicción, la idea es que este valor llegue lo más próximo a 0. Mientras más bajo sea el valor del loss nuestra red predecirá mejor. Para lograr esto debemos de calcular la gradiente, una gradiente simplemente nos indica cuánto es lo que cambia el loss si cambias los pesos. Entonces existe el método llamado backpropagation.
- **Zero grad:** Antes de realizar el backpropagation es importante resetear el valor del gradiente, esto nos ayuda a la hora de entrenar al modelo, al entrar en un bucle evitamos que se acumule el gradiente anterior y nos arroje errores silenciosos.
- **Backpropagation:** El concepto de backpropagation simplemente es el algoritmo para calcular la gradiente, con la diferencia de que empezamos desde atrás hacia adelante, o sea desde el loss hacia los pesos, usando la regla de la cadena. La regla de la cadena nos dice que debemos de multiplicar las derivadas locales de cada tramo del camino.
- **Update (descenso de gradiente):** Una vez que tenemos el gradiente de cada peso actualizamos los pesos moviéndolos en la dirección contraria a su gradiente. ¿Por qué en contra? Porque el gradiente apunta hacia donde el loss sube, y nosotros queremos que baje. En código, a cada peso le sumamos -learning_rate * su_gradiente, donde el learning rate es un valor pequeño (ej. 0.05) que controla el tamaño del paso. No tocamos el loss directamente, movemos los pesos, y el loss baja como consecuencia.
- **Repeat:** Luego de mover el peso, se repite el bucle desde el inicio, y así es como funciona este flujo de entrenamiento.

## En qué me confundí
1. **Peso vs Gradiente**
   Pensaba que un peso era lo mismo que su derivada total, o que la derivada total viene a ser el peso. Estaba pensando mal, ya que en realidad son dos números totalmente distintos. El peso es la posición y su gradiente es la inclinación.
2. **tanh: ¿por peso o por neurona?**
   Pensaba que el tanh se ejecutaba cada vez por peso, pero no, se ejecuta una vez por neurona sobre la suma w*x+b ya combinada, no por cada peso.
3. **El orden del tanh**
    Pensaba que después de calcular el loss, recién aplicábamos la activación (tanh), pero en realidad el tanh está DENTRO del forward, antes del loss. El orden es w*x+b -> tanh -> (...) -> loss. El tanh no viene después del loss.
4. **Forward/backward: ¿Por neurona o por red?**
    Pensaba que el forward y el backward se ejecutaban una vez por neurona, pero en realidad son una vez por toda la red. Solo el tanh es por neurona.
5. **Backprop = descenso de gradiente**
    Pensaba literalmente que eran lo mismo, pero no: backprop calcula los gradientes, el descenso de gradiente los usa para mover los pesos. Uno calcula, el otro actúa.
6. **El update mueve el peso, no el loss**
    Pensaba que al aplicar el descenso de gradiente era para reducir el loss, pero no funciona así: aplicamos el descenso de gradiente para mover los pesos, y por consecuencia el loss baja, no es que se toque directamente.
7. **Regla de la cadena: multiplicar vs sumar**
    ¿Cuándo multiplicar y cuándo sumar? Realmente multiplicamos las derivadas locales dentro de un camino, que es la cadena; sumamos cuando un nodo recibe gradiente de varios caminos.

## El código: construyendo la clase Value

Todo el motor gira alrededor de una sola clase: `Value`. La idea es envolver un número para que "recuerde" de dónde vino y cómo repartir su gradiente. Así empieza:

```python
class Value:
    def __init__(self, data, _children=()):
        self.data = data                # el número
        self.grad = 0.0                 # su gradiente (empieza en 0)
        self._prev = set(_children)     # de qué nodos nació
        self._backward = lambda: None   # cómo repartir el gradiente
```

Cada nodo guarda dos cosas clave: su valor (data) y su gradiente (grad) que, como aprendí a la mala, son cosas distintas.

Lo interesante pasa en las operaciones. Mi favorita es la multiplicación:

```python
def __mul__(self, other):
    out = Value(self.data * other.data, (self, other))

    def _backward():
        self.grad += other.data * out.grad
        other.grad += self.data * out.grad

    out._backward = _backward
    return out
```

Ese other.data * out.grad es literalmente la regla de la cadena: la derivada local por el gradiente que viene de atrás. Y el += en vez de = fue clave: si un nodo se usa en varios caminos, sus gradientes se suman.

Finalmente, backward() recorre todo el grafo de atrás hacia adelante:

```python
def backward(self):
    topo = []
    visited = set()

    def build_topo(v):
        if v not in visited:
            visited.add(v)
            for child in v._prev:
                build_topo(child)
            topo.append(v)
    build_topo(self)

    self.grad = 1.0
    for node in reversed(topo):
        node._backward()
```

El reversed() es lo que hace la "propagación hacia atrás": empieza en el resultado (con gradiente 1) y va hacia las entradas.

El código completo está en [mi repo](https://github.com/devedux/ai-engineering-journey/tree/main/semana-01-backprop).

## El resultado: la red aprendiendo

Junté todo, la red, la función de loss y el bucle de entrenamiento, y lo puse a correr 20 vueltas. Esto fue lo que pasó:

```
0  3.7367
1  1.7140
2  0.5487
...
18 0.0401
19 0.0378
```

El loss bajó de **3.73 a 0.038**. Eso significa que la red pasó de predecir casi al azar a acertar los valores que le pedía. Ver ese número bajar solo, vuelta tras vuelta, fue el momento en que todo lo anterior (derivadas, gradiente, backprop) cobró sentido: no era teoría, estaba funcionando frente a mí.

## Qué me llevo y qué sigue

Lo más valioso no fue el código en sí (son ~100 líneas), sino entender que **entrenar una red es solo repetir un ciclo**: predecir, medir el error, calcular hacia dónde ajustar, y mover los pesos un poquito. Eso es todo, desde este micrograd de juguete hasta un LLM.

Lo que más me sorprendió fue que algo que me parecía magia; cómo una red aprende sola, en realidad son derivadas encadenadas y un bucle que se repite. Pasé de no saber cómo se entrena una red a construir una y verla aprender. Sigue habiendo mucho que no sé, pero backprop ya no es una caja negra para mí.

---

Este ejercicio está basado en el excelente [micrograd de Andrej Karpathy](https://github.com/karpathy/micrograd) y su serie [Neural Networks: Zero to Hero](https://karpathy.ai/zero-to-hero.html), de donde aprendí todo esto.
