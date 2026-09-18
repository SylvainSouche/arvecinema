Legal note

Purpose

ArveCinema is a desktop application designed to help end users browse and select cinema screenings in the Arve Valley. It presents the schedules of several local cinemas in a single interface and enriches scheduled films with complementary information, including publicly available ratings.

This note sets out the main legal considerations taken into account in the design of the application, in particular copyright, the sui generis right of database makers, the distinction between ArveCinema’s own service and the databases from which complementary information is obtained, and the processing of personal data.

The analysis applies to the current implementation of ArveCinema and to the uses described in this repository.

1. Factual information and copyright

Film titles, screening dates and times, cinema names and numerical ratings are factual information. As such, these facts are not protected by copyright.

ArveCinema uses them to allow the end user to search for and select a screening, and provides additional information to help the user make an informed choice of film.

This must be distinguished from material that may contain original expression, such as synopses, editorial text and graphic material. ArveCinema does not constitute an editorial database reproducing such content. Where posters are displayed, they are referenced from their publicly available original location rather than collected into a centralized image repository operated by the service.

The purpose of the application is therefore to facilitate access to and presentation of screening information, rather than to independently exploit the editorial or graphic content of the websites consulted.

2. Sui generis database right

The European sui generis right protects substantial investment in obtaining, verifying or presenting the contents of a database. It does not create a general monopoly over the information contained in that database.

The European regime distinguishes, in particular, the extraction or re-utilisation of a substantial part of a database from the repeated and systematic extraction or re-utilisation of insubstantial parts where this conflicts with normal exploitation of the database or causes unjustified prejudice to the database maker.[^1]

In ArveCinema, complementary film information is not collected in order to reconstruct the general catalogues of the platforms consulted. It is obtained as an extension of the local cinema schedule: only films actually scheduled by the local cinemas are concerned, and ratings are used to enrich the presentation of those screenings.

The end user therefore does not obtain, through ArveCinema, a competing database of the services consulted. The user operates a local tool for browsing cinema schedules, with selected complementary information associated with the scheduled films.

The extraction is consequently ancillary to the service provided to the end user: it complements information about a film already identified in a local cinema programme rather than making the contents of a competing database available.

This distinction, together with the targeted nature and limited volume of the collection, supports the conclusion that the current use made by ArveCinema is compatible with the sui generis database right.[^1][^2]

3. Independent purpose and economic parasitism

ArveCinema has its own purpose: enabling the end user to browse screenings available at cinemas in the local area and select a screening.

Ratings obtained from third-party services are complementary information intended to assist that choice. They are not the core of an independent rating, ranking or recommendation service. They are not used to build a general catalogue or provide a search engine competing with the databases consulted.

The principal value of the ArveCinema service therefore lies in aggregating and presenting local cinema schedules, rather than reproducing or exploiting a third party’s ratings database.

The use of this information serves a purpose distinct from that of the services providing it. It does not reproduce their business activity or appropriate their investment in order to develop a competing service.

This distinction is consistent with the principles identified in French case law concerning parasitisme, under which the claimant must identify an individualised economic value and the third party’s intention to take advantage of that value. The cited case concerned a materially different competitive situation and is therefore relevant as a general principle rather than as a direct precedent for ArveCinema.[^3]

4. Local use and the end user

The architecture of ArveCinema reinforces this functional distinction.

Data collected as part of film enrichment is stored in the data directory of the user’s local installation. There is no central ratings database made available to a group of users.

The collection is therefore not organized as a data-distribution service based on information obtained from the platforms consulted. It is an auxiliary operation carried out to provide a particular end user, on that user’s own device, with complementary information associated with the cinema schedules being consulted.

This is important when assessing the actual purpose of the processing: the application does not seek to create and commercially exploit a new database based on the investments of the services consulted. It makes the consultation of local cinema screenings more convenient for an individual user.

5. Personal data and GDPR

ArveCinema does not collect, store or otherwise process personal information about its users for the purposes of the service. The application does not require user accounts, does not build user profiles, and does not use personal information to provide, personalize or monetize the service.

The data collected from cinema and rating websites concerns films, screenings, programmes, ratings and other information relating to the works themselves. It is not collected for the purpose of identifying or profiling individuals.

Accordingly, the operation described in this repository does not involve the collection or use of personal data by ArveCinema and is therefore outside the material scope of the GDPR for those operations. This assessment concerns the application’s own processing activities; it does not make any assertion about the processing of personal data that may independently be carried out by the third-party websites accessed by the application.

Any future feature involving user accounts, analytics, tracking, personalised recommendations, user profiles or other processing of information relating to identifiable individuals would require a separate GDPR assessment.

Conclusion

Based on its current operation, ArveCinema has been designed within a framework compatible with the applicable European principles concerning copyright, sui generis database rights and the protection of personal data.

The essential point is the function of the application: ArveCinema is a local tool for end users to browse local cinema schedules and facilitate the selection of a screening. Complementary information obtained from third-party services is used in a targeted manner to enrich that consultation; it is not exploited to create a competing database or reproduce the service provided by those third parties.

ArveCinema does not itself collect or process personal data about its users for the purposes of the service. The GDPR assessment therefore relates specifically to the application's own processing activities and does not extend to independent processing carried out by third-party websites.

This conclusion is based on the operation described in this repository. A future change towards general catalogue collection, a shared database, a search or ranking service based on third-party data, user accounts, analytics, tracking, personalised recommendations, or any other material change in the purpose or collection methods should be subject to a new legal assessment.

References

[^1]: Directive 96/9/EC of the European Parliament and of the Council of 11 March 1996 on the legal protection of databases, EUR-Lex, in particular Articles 7 and 8 and Recitals 39–49. The Directive protects substantial investment in obtaining, verifying or presenting database contents while permitting the extraction and re-utilisation of insubstantial parts subject to the conditions laid down by the Directive.
https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:31996L0009

[^2]: Court of Justice of the European Union, British Horseracing Board Ltd and Others v William Hill Organization Ltd, C-203/02, 9 November 2004, CURIA. The Court sets out the criteria for determining whether an extracted part is substantial, including quantitative and qualitative considerations relating to the investment in the database.
https://curia.europa.eu/juris/document/document.jsf?docid=49432&doclang=EN

[^3]: French Cour de cassation, Commercial Chamber, 26 June 2024, nos. 22-17.647 and 22-21.497, Légifrance. The Court describes economic parasitism as taking unfair advantage of another operator’s efforts, know-how, reputation or investments, and requires an identified and individualised economic value together with an intention to take advantage of it. The case concerned a different factual and competitive context.
https://www.legifrance.gouv.fr/juri/id/JURITEXT000049857376
