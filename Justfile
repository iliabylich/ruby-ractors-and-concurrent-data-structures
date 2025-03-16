md_files := shell('cat src/SUMMARY.md  | grep -o -E "[a-zA-Z0-9_./]*.md" | tr "\n" " "')

merge:
    cd src && cat {{md_files}} > ../merged.md
