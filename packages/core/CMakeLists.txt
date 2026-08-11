cmake_minimum_required(VERSION 3.22)
project(aurelith_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Der Simulationskern. Enthält keinerlei Plattformcode — er kennt weder Browser
# noch Node, weder Netzwerk noch Dateisystem. Genau deshalb lässt er sich
# nativ testen und nach wasm übersetzen, ohne dass sich sein Verhalten ändert.
add_library(aurelith_core STATIC
  src/world.cpp
  src/movement.cpp
  src/combat.cpp
  src/ai.cpp
  src/step.cpp
)

target_include_directories(aurelith_core PUBLIC include)
target_compile_options(aurelith_core PRIVATE -Wall -Wextra -Wpedantic)

if(EMSCRIPTEN)
  # --- wasm-Ziel -----------------------------------------------------------
  #
  # Eine Binärdatei, zwei Wirte: der Browser und der Node-Server laden dieselbe
  # Datei. Das ist der Grund, warum „dieselbe Simulation" hier keine
  # Behauptung ist, sondern eine Eigenschaft des Builds.

  add_executable(aurelith_core_wasm bindings/embind.cpp)
  target_link_libraries(aurelith_core_wasm PRIVATE aurelith_core)
  set_target_properties(aurelith_core_wasm PROPERTIES OUTPUT_NAME "aurelith_core" SUFFIX ".js")

  target_link_options(aurelith_core_wasm PRIVATE
    -lembind
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createAurelithCore
    -sENVIRONMENT=web,worker,node

    # Fester Heap, wächst nicht — dieselbe Disziplin wie bei Flyff, nur mit
    # einer Zahl, die zum Inhalt passt. Sie ist vorläufig: der Blueprint
    # verlangt eine gemessene Obergrenze auf dem schwächsten Zielgerät, und
    # diese Messung steht noch aus.
    -sALLOW_MEMORY_GROWTH=0
    -sINITIAL_MEMORY=67108864
    -sSTACK_SIZE=1048576

    # Kein virtuelles Dateisystem, keine Exceptions — beides braucht der Kern
    # nicht, und beides kostet spürbar Codegröße.
    -sFILESYSTEM=0
    -sDISABLE_EXCEPTION_CATCHING=1

    -sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU16','HEAPU32','HEAP32','HEAPF32']
    -sEXPORTED_FUNCTIONS=['_malloc','_free']

    -O3
  )
else()
  # --- Natives Testziel ----------------------------------------------------
  #
  # Läuft ohne Emscripten und ist damit die schnelle Rückmeldung beim
  # Entwickeln: Kompilierfehler und grobe Logikfehler fallen hier auf, lange
  # bevor irgendein Browser startet.

  enable_testing()
  add_executable(core_tests test/native_test.cpp)
  target_link_libraries(core_tests PRIVATE aurelith_core)
  target_compile_options(core_tests PRIVATE -Wall -Wextra)
  add_test(NAME core_tests COMMAND core_tests)
endif()
