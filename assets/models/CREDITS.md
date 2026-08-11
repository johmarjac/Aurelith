# Gelieferte Modelle

Alles hier ist von jemand anderem gemacht. Was unter CC-BY steht, **muss**
namentlich genannt werden — auch in einem Spiel, in dem das Modell nur als
Schwert in einer Faust auftaucht. Die Nennung gehört deshalb ins Repository und
nicht in eine Notiz nebenbei.

Wer ein Modell hinzufügt, trägt es hier ein. Ohne Eintrag kein Modell.

---

## wooden_sword.glb

- **Titel:** LowPoly Wooden Sword
- **Urheber:** endrit — https://sketchfab.com/endrit
- **Quelle:** https://sketchfab.com/3d-models/lowpoly-wooden-sword-6a25bcfe014445418093763e7dfe1996
- **Lizenz:** CC-BY-4.0 — http://creativecommons.org/licenses/by/4.0/
- **Auflage:** Namensnennung. Kommerzielle Nutzung erlaubt.

Der vom Urheber vorgegebene Nennungstext:

> This work is based on "LowPoly Wooden Sword"
> (https://sketchfab.com/3d-models/lowpoly-wooden-sword-6a25bcfe014445418093763e7dfe1996)
> by endrit (https://sketchfab.com/endrit) licensed under CC-BY-4.0
> (http://creativecommons.org/licenses/by/4.0/)

**Bearbeitung:** aus `scene.gltf` + `scene.bin` + Textur zu einer `.glb`
gepackt (`tools/pack-glb.mjs`), Basisfarbtextur von 2048 auf 256 Pixel
verkleinert. Das Modell selbst — Geometrie, UV, Material — ist unverändert.

Warum verkleinert: die gelieferte Textur wog 452 KiB für ein Modell aus 181
Vertizes, dessen Karte aus wenigen Farbflächen besteht. Bei 256 Pixeln sind es
14 KiB, und der mittlere Unterschied zum Original liegt unter einem Prozent —
gemessen, nicht geschätzt.

---

## wooden_bow.glb

- **Titel:** Wooden Bow
- **Urheber:** TridentCorp — https://sketchfab.com/tridentcorp
- **Quelle:** https://sketchfab.com/3d-models/wooden-bow-1ebec675540a495e93fefbd2c0336eaa
- **Lizenz:** CC-BY-4.0 — http://creativecommons.org/licenses/by/4.0/
- **Auflage:** Namensnennung. Kommerzielle Nutzung erlaubt.

Der vom Urheber vorgegebene Nennungstext:

> This work is based on "Wooden Bow"
> (https://sketchfab.com/3d-models/wooden-bow-1ebec675540a495e93fefbd2c0336eaa)
> by TridentCorp (https://sketchfab.com/tridentcorp) licensed under CC-BY-4.0
> (http://creativecommons.org/licenses/by/4.0/)

**Bearbeitung:** zu einer `.glb` gepackt, Basisfarbtextur von 2048 auf 256
Pixel verkleinert (2054 → 40 KiB). Modell unverändert.

Das Modell liegt mit den Wurfarmen entlang Z statt aufrecht — deshalb steht in
der Waffenbeschreibung `axis: 'z'`. Gedreht wird beim Laden, nicht in der
Datei: die bleibt so, wie sie geliefert wurde.
