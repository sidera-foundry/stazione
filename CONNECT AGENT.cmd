@echo off
rem Double-click to connect this computer to Stazione.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\connect-agent.ps1"
