/**
 * Reicht three.js unter einem Pfad durch, den ein Werkzeug laden kann.
 *
 * Gedacht für `tools/shot-aura.mjs`: ein dynamischer Import im Browser kann
 * keinen Bare-Specifier auflösen, und ein Pfad nach `node_modules` hinge an
 * der Ablage im Dateisystem. Diese Datei ist die eine Stelle, die beides
 * verbindet — im Spiel selbst wird sie nicht gebraucht.
 */

export * from 'three';
