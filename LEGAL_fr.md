Note juridique

Objet

ArveCinema est une application desktop destinée à faciliter, pour l’utilisateur final, la consultation et la sélection de séances de cinéma dans la vallée de l’Arve. Elle présente dans une même interface les programmes de plusieurs cinémas locaux et les enrichit d’informations complémentaires sur les films programmés, notamment leurs évaluations publiques.

La présente note expose les principaux éléments juridiques pris en compte dans la conception de l’application, en particulier au regard du droit d’auteur, du droit sui generis des producteurs de bases de données, du parasitisme et des règles relatives à l’accès aux systèmes de traitement automatisé de données.

L’analyse porte sur le fonctionnement actuel d’ArveCinema et sur les usages décrits dans le présent dépôt.

1. Informations factuelles et droit d’auteur

Les titres de films, dates et horaires de séances, noms de cinémas et évaluations chiffrées constituent des informations factuelles. Ces informations, en tant que telles, ne relèvent pas de la protection du droit d’auteur.

ArveCinema les utilise pour permettre à l’utilisateur final de rechercher et sélectionner une séance, puis fournit, à titre complémentaire, des informations permettant d’éclairer son choix de film.

Cette utilisation doit être distinguée des éléments susceptibles de présenter une originalité propre, notamment les synopsis, textes éditoriaux et éléments graphiques. ArveCinema ne constitue pas une base éditoriale reproduisant ces contenus. Les affiches, lorsqu’elles sont affichées, sont référencées à partir de leur emplacement public d’origine plutôt que constituées en fonds d’images centralisé par le service.

Le service poursuit ainsi une finalité d’accès et de présentation de l’information relative aux séances, et non une exploitation autonome des contenus éditoriaux ou graphiques des sites consultés.

2. Droit sui generis des bases de données

Le droit sui generis des producteurs de bases de données protège l’investissement substantiel consacré à l’obtention, à la vérification ou à la présentation du contenu d’une base. Il ne confère pas un monopole général sur les informations contenues dans cette base.

Le régime européen distingue notamment l’extraction ou la réutilisation d’une partie substantielle de la base et l’extraction ou la réutilisation répétée et systématique de parties non substantielles lorsqu’elle porte atteinte à l’exploitation normale de la base ou cause un préjudice injustifié.[^1]

Dans ArveCinema, les informations complémentaires relatives aux films ne sont pas collectées afin de reconstituer les catalogues généraux des plateformes consultées. Elles sont obtenues dans le prolongement du programme des cinémas locaux : seuls les films effectivement programmés sont concernés et les évaluations servent à enrichir la présentation de ces séances.

L’utilisateur final n’accède donc pas, au travers d’ArveCinema, à une base concurrente de celles des services consultés. Il utilise un outil local de consultation des programmes de cinéma auquel certaines informations complémentaires sont associées.

La fonction de l’extraction est ainsi subordonnée au service rendu à l’utilisateur final : elle permet de compléter l’information sur un film déjà identifié dans un programme local, et non de mettre à disposition le contenu d’une base de données concurrente.

Cette distinction, combinée au caractère ciblé de la collecte et à son volume limité, conduit à considérer l’utilisation actuelle d’ArveCinema comme compatible avec le droit sui generis des bases de données.[^1][^2]

3. Finalité propre et parasitisme

ArveCinema poursuit une finalité propre : permettre à l’utilisateur final de consulter les séances disponibles dans les cinémas de son territoire et de choisir une séance.

Les évaluations provenant de services tiers constituent une information complémentaire destinée à éclairer ce choix. Elles ne constituent pas le cœur d’un service autonome de notation, de classement ou de recommandation. Elles ne servent pas à construire un catalogue général ni à fournir à l’utilisateur un moteur de recherche concurrent des bases consultées.

La valeur principale du service proposé par ArveCinema réside ainsi dans l’agrégation et la présentation des programmes des cinémas locaux, et non dans la reproduction ou l’exploitation de la base d’évaluations d’un tiers.

L’utilisation de ces informations s’inscrit donc dans une finalité distincte de celle des services qui les fournissent et ne consiste pas à reproduire leur activité ou à s’approprier leur investissement pour développer un service concurrent.

Ces éléments sont également cohérents avec les critères dégagés par la jurisprudence en matière de parasitisme, qui suppose notamment l’identification d’un comportement consistant à se placer dans le sillage d’un autre opérateur afin de tirer indûment profit de ses investissements ou de sa valeur économique.[^3]

4. Utilisation locale et utilisateur final

L’architecture d’ArveCinema renforce cette distinction fonctionnelle.

Les données collectées dans le cadre de l’enrichissement des films sont conservées dans le répertoire de données de l’installation locale de l’utilisateur. Il n’existe pas de base centrale d’évaluations mise à la disposition d’un ensemble d’utilisateurs.

La collecte n’est donc pas organisée comme un service de distribution de données issues des plateformes consultées. Elle constitue une opération auxiliaire réalisée pour fournir à l’utilisateur final, sur son propre poste, une information complémentaire à la consultation des programmes.

Cette organisation est particulièrement importante pour apprécier la finalité réelle du traitement : l’application ne cherche pas à constituer et exploiter commercialement une nouvelle base à partir des investissements des services consultés, mais à rendre plus pratique, pour un utilisateur donné, la consultation des séances auxquelles ces informations se rapportent.

5. Accès aux systèmes et automatisation

ArveCinema accède à des informations publiquement accessibles sur les sites concernés. Il ne nécessite pas d’authentification de l’utilisateur auprès de ces sites et n’a pas pour objet d’accéder à des espaces ou données réservés.

L’existence de dispositifs techniques destinés à limiter les consultations automatisées doit être distinguée d’un mécanisme d’autorisation destiné à réserver l’accès à un système ou à certaines données à des utilisateurs déterminés.

L’article 323-1 du Code pénal réprime l’accès ou le maintien frauduleux dans tout ou partie d’un système de traitement automatisé de données.[^4] La qualification suppose donc un caractère frauduleux de l’accès ou du maintien ; elle ne résulte pas de la seule circonstance qu’un accès est réalisé au moyen d’un traitement automatisé.

La jurisprudence dite « Bluetouff » illustre notamment l’importance, dans l’appréciation du caractère frauduleux, de la connaissance d’un dispositif manifestant que l’accès au système ou aux données est réservé.[^5] Elle ne porte pas sur l’utilisation d’un mécanisme de limitation des consultations automatisées d’un contenu publiquement accessible et ne permet donc pas d’assimiler ces deux situations.

Dans le fonctionnement actuel d’ArveCinema, l’accès concerne des informations publiquement présentées et s’inscrit dans la fourniture du service de consultation destiné à l’utilisateur final. En l’absence d’accès à une partie réservée du système ou à des données soustraites à l’accès public, cet accès ne caractérise pas un accès frauduleux au sens de l’article 323-1.

Conclusion

Au regard de son fonctionnement actuel, ArveCinema a été conçu dans un cadre compatible avec les règles applicables en matière de droit d’auteur, de droit sui generis des bases de données, de parasitisme et d’accès aux systèmes de traitement automatisé de données.

Le point essentiel tient à la fonction de l’application : ArveCinema est un outil local destiné à l’utilisateur final pour consulter les programmes des cinémas locaux et faciliter le choix d’une séance. Les informations complémentaires provenant de services tiers sont utilisées de manière ciblée pour enrichir cette consultation ; elles ne sont pas exploitées afin de constituer une base concurrente ou de reproduire le service fourni par ces tiers.

Cette conclusion est attachée au fonctionnement décrit dans le présent dépôt. Une évolution vers une collecte générale de catalogues, une base de données mutualisée, un service de recherche ou de classement fondé sur les données de tiers, ou toute autre modification substantielle de la finalité ou des modalités de collecte devrait faire l’objet d’une nouvelle analyse.

Références

[^1]: Directive 96/9/CE du Parlement européen et du Conseil du 11 mars 1996 concernant la protection juridique des bases de données, EUR-Lex, notamment articles 7 et 8 et considérants 39 à 49.
https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:31996L0009

[^2]: Cour de justice de l’Union européenne, British Horseracing Board Ltd c. William Hill Organization Ltd, C-203/02, 9 novembre 2004, CURIA. La Cour précise notamment les critères permettant d’apprécier le caractère substantiel d’une partie de base de données.
https://curia.europa.eu/juris/document/document.jsf?docid=49432&doclang=FR

[^3]: Cour de cassation, chambre commerciale, 26 juin 2024, nos 22-17.647 et 22-21.497, Légifrance. La jurisprudence rappelle les éléments permettant de caractériser le parasitisme, notamment l’appropriation injustifiée de la valeur économique résultant des investissements d’autrui.
https://www.legifrance.gouv.fr/juri/id/JURITEXT000049857376

[^4]: Code pénal, article 323-1, Légifrance.
https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000045292599

[^5]: Cour de cassation, chambre criminelle, 20 mai 2015, n° 14-81.336, Légifrance. La décision concerne notamment le caractère frauduleux du maintien après découverte d’un dispositif d’accès réservé.
https://www.legifrance.gouv.fr/juri/id/JURITEXT000030645456
