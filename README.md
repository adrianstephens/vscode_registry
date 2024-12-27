"😀"
<span data-index="1"></span>
# Visual Studio Code Registry Editor

This extension adds a registry editor to the explorer, and general support for .reg files.

![Main window screenshot](assets/readme.png)


Keys and Values have context menus allowing deletion, renaming, etc.

The 'Edit' option on keys generates a .reg file which, when saved, is automatically imported into the registry, updating the views accordingly.

## What's New

By default, the Registry editor now goes into its own Activity Bar view. If you prefered it in the explorer container it can be dragged there.

Syntax highlighting for continuation lines are (hopefully) working properly now (thanks for reporting, David Salsburg).

## Optional Executable

It seems administrators can lock people out of using reg.exe, even to query the registry. As a workaround I've added a setting for using an alternative executable, which has to be largely compatible with reg's command line options.

If you're wondering where on earth you could find such an executable, I supply one within this very extension!


## Author
Adrian Stephens


